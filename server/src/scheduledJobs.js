// Background recompute jobs — the live snapshot, the current electric
// billing cycle's cost estimate, and the Analytics page's heavy reads are
// all refreshed on a timer, off the request path entirely, so a page view
// is always just reading an already-computed value.
//
// Analytics warming has a rougher history than the other two, worth
// knowing before touching this file again:
//
// 1. First attempt: a separate worker thread (its own SQLite connection +
//    its own V8 heap, so the main event loop would never block on it). On
//    this VM's 450MB memory cap that backfired: the worker's heap + page
//    cache stacked on top of the main thread's, pinning the whole process
//    at the cap and swapping constantly — which made *everything* slow
//    (even /api/health), not just Analytics.
// 2. Second attempt: a plain setInterval() on the main thread instead (no
//    standing memory cost) — but computeAnalytics()/hourlyConsumption()
//    were still scanning raw rows, which turned out far too slow for this
//    VM's throttled disk at the database's size by then: a single run was
//    measured at 216s and, after fixing a scheduling bug that let two runs
//    overlap, *273s solo* — during which the whole app was unresponsive
//    (node:sqlite queries are fully synchronous, so a long JS loop over raw
//    rows blocks every other request). The 90-day daily-trend part alone
//    meant re-scanning up to ~89 individual days from raw rows after every
//    restart, since its cache was an in-memory Map wiped each time.
//    Analytics warming was pulled entirely after this — two real outages
//    in one afternoon was enough for one day.
// 3. What's scheduled now: computeAnalytics()/hourlyConsumption() were
//    rewritten (store.js) to read from the readings_1m per-minute
//    aggregate instead of raw rows — the same change that already took
//    queryHistory() from ~22s to ~0.1s for a 7-day range. Measured directly
//    against production: 24h went from 1.2s to ~50ms (24x), 7d from ~6.8s
//    to ~135ms (51x) — safe to warm on a schedule again. The 90-day daily
//    trend (dailyConsumption(), used by weather correlation) is NOT
//    included below — it still scans raw rows and wasn't part of this
//    rewrite, so it stays lazy (computed on first real visit, same as
//    before any warming existed) rather than risk repeating outage #2 for
//    a feature nobody's asked to see load instantly.
//
// Trade-off worth knowing about the fast path: peak demand, standby load,
// and per-circuit std-dev now reflect per-*minute* averages, not the
// single most extreme 2-second raw reading — see the doc comment on
// computeAnalytics() in store.js for exactly what that does and doesn't
// change.
import { refreshLiveSnapshot, computeAnalytics, hourlyConsumption } from "./store.js";
import { getSunWindow } from "./weather.js";
import { localDateStr, localDateToUtcMs } from "./tz.js";
import { electricCycleRange } from "./billing.js";
import { refreshCurrentCycleCost } from "./billingCost.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Windows the Analytics range picker's presets actually request. Shorter
// presets (15m/1h/6h) are cheap enough raw even without this.
const SPANS = [DAY, 7 * DAY];

/** `getContext()` → { channelKinds, channelLabels, timezone, location } — re-read every run, since channel config can change. */
export function startScheduledJobs(getContext) {
  // A run that's still going when its own next trigger fires would overlap
  // with itself and compete for the same disk — guard against that even
  // though both jobs below are normally fast now; see the analytics
  // history above for exactly how badly that compounded when it happened.
  let liveRunning = false;
  let analyticsRunning = false;

  /** Today's snapshot and the current electric billing cycle's cost estimate — the two figures a page load can't avoid needing "now." */
  async function refreshLive() {
    if (liveRunning) return;
    liveRunning = true;
    try {
      const { channelKinds, channelLabels, timezone, location } = getContext();
      let sunWindow = null;
      if (location) {
        try {
          sunWindow = await getSunWindow(localDateStr(Date.now(), timezone), location);
        } catch (err) {
          console.warn(`[cron] sun window lookup failed: ${err.message}`);
        }
      }
      refreshLiveSnapshot({ channelKinds, channelLabels, timezone, sunWindow });
    } catch (err) {
      console.warn(`[cron] live snapshot refresh failed: ${err.message}`);
    }

    try {
      const { channelKinds, channelLabels, timezone } = getContext();
      const { start: cycleStartStr, end: cycleEndStr } = electricCycleRange(localDateStr(Date.now(), timezone));
      refreshCurrentCycleCost({
        fromMs: localDateToUtcMs(cycleStartStr, timezone),
        toMs: localDateToUtcMs(cycleEndStr, timezone),
        timezone,
        channelKinds,
        channelLabels,
      });
    } catch (err) {
      console.warn(`[cron] billing cycle cost refresh failed: ${err.message}`);
    } finally {
      liveRunning = false;
    }
  }

  async function refreshAnalytics() {
    if (analyticsRunning) {
      console.log("[cron] analytics refresh already in progress — skipping this trigger");
      return;
    }
    analyticsRunning = true;
    const started = Date.now();
    try {
      const { channelKinds, channelLabels, timezone } = getContext();
      const to = Date.now();
      for (const span of SPANS) {
        await computeAnalytics({ from: to - span, to, channelKinds, channelLabels, timezone });
        hourlyConsumption({ from: to - span, to, channelKinds, timezone });
      }
      console.log(`[cron] analytics cache refreshed in ${(Date.now() - started).toFixed(0)}ms`);
    } catch (err) {
      console.warn(`[cron] analytics refresh failed: ${err.message}`);
    } finally {
      analyticsRunning = false;
    }
  }

  // Live snapshot + current billing cycle cost: soon after startup, then
  // every 15 minutes.
  setTimeout(refreshLive, 5_000).unref();
  setInterval(refreshLive, 15 * MIN).unref();

  // Analytics: shortly after startup, then every hour — counted from
  // server start, not aligned to the wall-clock hour (a restart landing
  // near the top of an hour used to put this trigger and the next one only
  // tens of seconds apart; the analyticsRunning guard above would now just
  // skip the second one rather than let them overlap, but not creating the
  // coincidence in the first place is better still).
  setTimeout(refreshAnalytics, 30_000).unref();
  setInterval(refreshAnalytics, HOUR).unref();
}
