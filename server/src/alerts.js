// Usage alerts: "notify me when consumption is N% above what's usual for
// this time of day." Runs off the same reading stream everything else does
// — no separate cron/timer — internally throttled to check at most once
// per CHECK_INTERVAL_MS.
import { db } from "./db.js";
import { hourlyBaselineConsumption, recentAverageConsumption } from "./store.js";
import { localHour } from "./tz.js";
import { broadcastNotification, subscriptionCount } from "./push.js";

const getSettingStmt = db.prepare("SELECT value FROM app_settings WHERE key = ?");
const setSettingStmt = db.prepare(
  "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

const DEFAULTS = { enabled: false, thresholdPct: 40 };

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // how often we actually look
const RECENT_WINDOW_MIN = 15; // "right now" smoothing window
const BASELINE_DAYS = 28; // how far back "usual for this hour" looks
const BASELINE_MIN_SAMPLES = 200; // ~ a handful of days at this hour, minimum before trusting the baseline
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // don't re-alert inside 2h of the last one

export function getAlertSettings() {
  const row = getSettingStmt.get("alert_settings");
  return row ? { ...DEFAULTS, ...JSON.parse(row.value) } : { ...DEFAULTS };
}

export function setAlertSettings(patch) {
  const next = { ...getAlertSettings(), ...patch };
  setSettingStmt.run("alert_settings", JSON.stringify(next));
  return next;
}

function lastAlertTs() {
  const row = getSettingStmt.get("last_alert_ts");
  return row ? Number(row.value) : 0;
}

let lastCheckTs = 0;

/**
 * Called on every incoming reading; internally throttled so the actual
 * baseline comparison only runs once per CHECK_INTERVAL_MS. Pushes one
 * notification to every subscribed device if usage over the last
 * RECENT_WINDOW_MIN minutes is thresholdPct% above the historical average
 * for this hour of day, and we're past the cooldown from the last alert.
 */
export async function maybeCheckUsage(channelKinds, timezone) {
  const now = Date.now();
  if (now - lastCheckTs < CHECK_INTERVAL_MS) return;
  lastCheckTs = now;

  const settings = getAlertSettings();
  if (!settings.enabled || subscriptionCount() === 0) return;
  if (now - lastAlertTs() < COOLDOWN_MS) return;

  const recent = recentAverageConsumption({ minutes: RECENT_WINDOW_MIN, channelKinds });
  if (recent.avg === null) return;

  const hour = localHour(now, timezone);
  const baseline = hourlyBaselineConsumption({
    from: now - BASELINE_DAYS * 24 * 3600 * 1000,
    to: now - RECENT_WINDOW_MIN * 60 * 1000, // exclude the window we're comparing against
    hour,
    channelKinds,
    timezone,
  });
  if (baseline.avg === null || baseline.sampleCount < BASELINE_MIN_SAMPLES || baseline.avg <= 0) return;

  const pctOver = ((recent.avg - baseline.avg) / baseline.avg) * 100;
  if (pctOver < settings.thresholdPct) return;

  setSettingStmt.run("last_alert_ts", String(now));
  await broadcastNotification({
    title: "Usage running high",
    body: `${Math.round(recent.avg).toLocaleString()} W right now — about ${Math.round(pctOver)}% above the ${Math.round(
      baseline.avg
    ).toLocaleString()} W that's typical for this time of day.`,
    url: "/",
  });
}
