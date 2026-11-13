import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";

import { startMqttIngest } from "./mqtt.js";
import {
  addReading,
  initStore,
  queryHistory,
  querySummary,
  computeAnalytics,
  hourlyConsumption,
  dailyConsumption,
  todaySnapshot,
  dailySnapshots,
  persistDailySnapshotIfComplete,
  earliestTimestamp,
} from "./store.js";
import { getChannelList, updateChannel, decorateChannels, getChannelFactors } from "./channelConfig.js";
import { MAIN_INDEXES } from "./channels.js";
import { initAuth, login, logout, sessionEmail, requestPasswordReset, resetPassword } from "./auth.js";
import {
  getWeatherLocation,
  setWeatherZip,
  getHourlyTemps,
  getConfiguredTimezone,
  getTodayWarmest,
  getDayWarmest,
  getSunWindow,
  getSunWindowsForRange,
  localDateStr,
} from "./weather.js";
import { initPush, addSubscription, removeSubscription, pushReady } from "./push.js";
import { initMail, sendPasswordResetEmail } from "./mail.js";
import { isWithinDaylight, localDateToUtcMs } from "./tz.js";
import { getBillingSettings, setBillingSettings } from "./billing.js";
import { estimatePeriodCost, getCachedCycleCost } from "./billingCost.js";
import { startScheduledJobs } from "./scheduledJobs.js";
import { getCalibrationFactor, setCalibrationFactor, getImportCorrection, setImportCorrection, correctImportWatts } from "./calibration.js";
import { getAlertSettings, setAlertSettings, maybeCheckUsage } from "./alerts.js";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  refreshLinkToken,
  isAccountLinked,
  storeGrantToken,
  triggerRoutine,
} from "./alexaSkill.js";
import {
  getDailyEmailSettings,
  setDailyEmailSettings,
  maybeSendDailyReport,
  sendTestDailyReport,
  dayBeforeStr,
} from "./dailyEmail.js";

// Load the repo-root .env (shared with validate_semmeter_mqtt.py) in addition
// to any server/.env override.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const PORT = process.env.PORT || 8787;
const {
  SEMMETER_USER,
  SEMMETER_PASS,
  DEVICE_SN,
  MQTT_HOST = "mqtt001.tumblevd.com",
  MQTT_PORT = "6000",
} = process.env;

if (!SEMMETER_USER || !SEMMETER_PASS || !DEVICE_SN) {
  console.error(
    "[fatal] Missing SEMMETER_USER / SEMMETER_PASS / DEVICE_SN. Set them in the repo-root .env."
  );
  process.exit(1);
}

const storedCount = initStore(getChannelList().map((c) => c.kind), getConfiguredTimezone());
console.log(`[store] ${storedCount} historical reading(s) on disk (SQLite)`);

initPush({
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT,
});

initMail({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  token: process.env.SMTP_TOKEN,
  from: process.env.MAIL_FROM,
});

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const authBootstrap = initAuth(ADMIN_EMAIL);
if (authBootstrap.created) {
  // Only time this password is ever visible in plaintext — use the
  // forgot-password flow (or check this log via SSH) to set
  // a real one instead of relying on this.
  console.log(`[auth] created admin account ${authBootstrap.email} with initial password: ${authBootstrap.initialPassword}`);
} else {
  console.log(`[auth] admin account ${authBootstrap.email} already exists`);
}

let latestReading = null;
let mqttStatus = { state: "connecting" };

// Today's sunrise/sunset, cached in memory so every single reading (every
// couple seconds) doesn't need a DB lookup or Open-Meteo call just to know
// day from night — see decorateChannels() in channelConfig.js for why that
// matters. Refreshed lazily: cheap to call on every reading (one string
// compare) and only actually re-fetches once, right after the calendar day
// rolls over.
let sunWindowCache = { date: null, window: null };

async function refreshSunWindowCache() {
  const location = getWeatherLocation();
  if (!location) {
    sunWindowCache = { date: null, window: null };
    return;
  }
  const dateStr = localDateStr(Date.now(), getConfiguredTimezone());
  if (sunWindowCache.date === dateStr) return;
  try {
    const window = await getSunWindow(dateStr, location);
    sunWindowCache = { date: dateStr, window };
  } catch (err) {
    console.warn(`[weather] sun window refresh failed: ${err.message}`);
  }
}

function isDaytimeNow() {
  return isWithinDaylight(Date.now(), sunWindowCache.window) ?? true; // unknown -> don't reclassify
}

// Warm the cache before the first reading arrives, so it isn't defaulting
// to "daytime" for a stretch right after every restart.
await refreshSunWindowCache();

// The Daily Snapshots page's per-day cache (see daily_snapshots in
// store.js) is normally warmed here, proactively, right as each local day
// ends — same lazy-detection pattern as the sun window cache above (cheap
// string compare on every reading, only actually does work once, the
// instant the calendar day rolls over). Without this, that page would
// still work (dailySnapshots() computes and caches on-demand as a
// fallback), just with the first view of any given day being a one-time
// slow raw-row scan instead of an instant cache hit.
let lastSeenLocalDateStr = null;

async function maybeRollupYesterday() {
  const timezone = getConfiguredTimezone();
  const todayStr = localDateStr(Date.now(), timezone);
  if (lastSeenLocalDateStr === null) {
    lastSeenLocalDateStr = todayStr; // first reading since boot — nothing "just ended" yet
    return;
  }
  if (lastSeenLocalDateStr === todayStr) return;
  const finishedDateStr = lastSeenLocalDateStr;
  lastSeenLocalDateStr = todayStr;

  const location = getWeatherLocation();
  const sunWindow = location ? await getSunWindow(finishedDateStr, location) : null;
  const channels = getChannelList();
  const channelKinds = channels.map((c) => c.kind);
  const channelLabels = channels.map((c) => c.label);
  const snapshot = persistDailySnapshotIfComplete(finishedDateStr, { channelKinds, channelLabels, timezone, sunWindow });
  // pid added temporarily alongside the mail.js/dailyEmail.js diagnostics
  // for the double daily-email issue — see those files' comments.
  console.log(`[store] pid=${process.pid} cached daily snapshot for ${finishedDateStr} (snapshot: ${snapshot ? `sampleCount=${snapshot.sampleCount} totalKwh=${snapshot.totalKwh}` : "null"})`);

  try {
    await maybeSendDailyReport(finishedDateStr, {
      channelKinds,
      channelLabels,
      timezone,
      location,
      yesterdaySnapshot: snapshot,
    });
  } catch (err) {
    console.warn(`[mail] daily report for ${finishedDateStr} failed: ${err.message}`);
  }
}

// Decorate a raw parsed reading with current channel config, and sign the
// grid's total power: positive while importing (pulling from the grid),
// negative while exporting (pushing surplus back out).
//
// The 3 main channels only ever report an unsigned magnitude — direction
// is inferred above (decorateChannels) from the *circuits'* own
// production/consumption balance, not measured from the mains themselves.
// channels.js's parseSensePayload applies the mains calibration factor
// uniformly to that magnitude, since it has no way to know direction yet
// (that's derived here, downstream of parsing). But the factor was only
// ever derived and validated against import-direction data (see
// calibration.js/README): a direct comparison against an exact SDGE
// 15-minute CSV export, across 4 independent full days, showed import
// staying within ordinary tolerance while export ran a *consistent*
// ~42-46% low — almost exactly what applying the factor a second time
// (so to speak) would do, since the raw uncalibrated export magnitude
// already matches SDGE's own Generation figures closely. So: undo the
// factor on the 3 main channels specifically, only when this reading
// turns out to be an export.
//
// Importing readings instead get the gain + offset import correction
// (calibration.js#getImportCorrection — identity unless configured): the
// mains' combined magnitude is corrected, and each main channel scaled by
// the same ratio so the per-leg split stays as measured.
function withGridDirection(reading) {
  const { channels, direction } = decorateChannels(reading.channels, { isDaytime: isDaytimeNow() });
  const calibrationFactor = getCalibrationFactor();
  let mainScale = 1;
  if (direction === "exporting" && calibrationFactor > 0) {
    mainScale = 1 / calibrationFactor;
  } else if (direction !== "exporting") {
    const correction = getImportCorrection();
    if (correction.gain !== 1 || correction.offsetW !== 0) {
      const raw = channels.filter((c) => MAIN_INDEXES.includes(c.index)).reduce((s, c) => s + c.power, 0);
      mainScale = raw > 0 ? correctImportWatts(raw, correction) / raw : 1;
    }
  }
  const decorated =
    mainScale !== 1
      ? channels.map((c) => (MAIN_INDEXES.includes(c.index) ? { ...c, power: Math.round(c.power * mainScale * 100) / 100 } : c))
      : channels;
  const magnitude = Math.round(
    decorated.filter((c) => MAIN_INDEXES.includes(c.index)).reduce((s, c) => s + c.power, 0) * 100
  ) / 100;
  return {
    ...reading,
    channels: decorated,
    totalPower: direction === "exporting" ? -magnitude : magnitude,
    gridDirection: direction,
  };
}

const SESSION_COOKIE = "sem_session";

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function requireAuth(req, res, next) {
  const email = sessionEmail(req.cookies[SESSION_COOKIE]);
  if (!email) return res.status(401).json({ error: "authentication required" });
  req.adminEmail = email;
  next();
}

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  req.cookies = parseCookies(req);
  next();
});

// Serve the built frontend (web/dist, produced by `npm run build` in web/)
// when it's present, so a single process serves API + WebSocket + UI in
// production. In local dev there's no dist/ and this is a no-op — the Vite
// dev server handles the UI instead.
const WEB_DIST = path.join(__dirname, "..", "..", "web", "dist");
if (fs.existsSync(WEB_DIST)) {
  // Served at an extension-less path on purpose: Cloudflare's default edge
  // cache matches static files by URL extension (.js included) and was
  // observed rewriting this response's Cache-Control to a 4h max-age,
  // silently overriding the origin's no-cache header below. /manifest
  // .webmanifest and index.html aren't on Cloudflare's default cached-
  // extension list and pass through fine — this path dodges the same way,
  // since a stale service worker can freeze every future deploy for
  // whoever already fetched it.
  app.get("/sw", (_req, res) => {
    res.type("text/javascript");
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(WEB_DIST, "sw.js"));
  });

  // A plain path alias for the smartwatch view (see WatchView.tsx /
  // main.tsx), which normally opens via `?watch=1`. Some watch browsers'
  // address bar is search-only and won't accept a `:` (no `https://`) or
  // sometimes even a `?` — a bare path like "meter.langecornu.com/watch"
  // is typeable there and most mobile browsers auto-detect a domain-
  // looking string like that and navigate directly instead of searching.
  app.get("/watch", (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });

  app.use(
    express.static(WEB_DIST, {
      setHeaders: (res, filePath) => {
        // index.html, sw.js, and the manifest must never be served stale.
        // This site sits behind Cloudflare's proxy, which caches static-
        // looking files (by extension — .js/.json-ish included) at the edge
        // by default regardless of how fresh the origin actually is. Without
        // this, a Cloudflare-cached sw.js or manifest.webmanifest would
        // silently freeze every future frontend deploy — including future
        // service worker updates — for anyone who already hit the cached
        // copy. "no-cache" (not "no-store") still allows a conditional GET,
        // so it costs a round-trip, not a full refetch, when unchanged.
        if (filePath.endsWith("index.html") || filePath.endsWith("sw.js") || filePath.endsWith("manifest.webmanifest")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    })
  );
  console.log(`[server] serving built frontend from ${WEB_DIST}`);
}

app.get("/api/health", (_req, res) => {
  // No deviceSn here — this is a public, unauthenticated endpoint, and the
  // serial number is otherwise never shown outside server-side logs.
  res.json({ ok: true, mqtt: mqttStatus, earliest: earliestTimestamp() });
});

// Amazon requires a reachable Privacy Notice URL for the Alexa Skill build
// (and sometimes the LWA security profile) — even for a personal,
// unpublished skill. Public, unauthenticated, static content; no template
// rendering, so it can't leak anything from the rest of the app.
app.get("/privacy", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Privacy Notice — Ohm Sweet Ohm</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 0 auto; padding: 32px 20px 60px; line-height: 1.6; color: #222; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 32px; }
  code { background: #f2f2f0; padding: 1px 5px; border-radius: 4px; }
</style></head>
<body>
  <h1>Privacy Notice — Ohm Sweet Ohm</h1>
  <p><em>Last updated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</em></p>

  <p>Ohm Sweet Ohm is a private, single-household home energy dashboard. It
  is not a public product and has exactly one user. This notice covers the
  "AC Boost" Alexa Skill component specifically.</p>

  <h2>What the Skill does</h2>
  <p>The Skill exposes one virtual on/off switch to the Alexa account it's
  linked to. It has no other function. Turning that switch on is used
  purely as a trigger for an Alexa Routine the account holder configures
  themselves — the Skill does not control, read from, or otherwise interact
  with any thermostat, appliance, or other smart home device.</p>

  <h2>What data is involved</h2>
  <p>Linking the Skill uses the same login already used for the Ohm Sweet
  Ohm dashboard (an email address and a password, verified on this
  server — never sent to or stored by Amazon). Beyond the OAuth tokens
  required to authorize sending the switch's on/off state, no personal
  data, location data, energy-usage data, or device data is sent to,
  collected by, or shared through this Skill.</p>

  <h2>Data sharing</h2>
  <p>No data collected here is sold, shared, or disclosed to any third
  party. There are no advertising or analytics services involved.</p>

  <h2>Contact</h2>
  <p>Questions about this notice can be directed to the account holder via
  the Ohm Sweet Ohm dashboard at <code>meter.langecornu.com</code>.</p>
</body></html>`);
});

app.get("/api/channels", (_req, res) => {
  res.json({ channels: getChannelList(), mainIndexes: [16, 17, 18] });
});

app.get("/api/auth/me", (req, res) => {
  const email = sessionEmail(req.cookies[SESSION_COOKIE]);
  res.json({ authenticated: !!email, email: email ?? null });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  const result = login(email, password);
  if (!result) return res.status(401).json({ error: "invalid email or password" });
  res.cookie(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || req.headers["x-forwarded-proto"] === "https",
    maxAge: 30 * 24 * 3600 * 1000,
    path: "/",
  });
  res.json({ ok: true, email: result.email });
});

app.post("/api/auth/logout", (req, res) => {
  logout(req.cookies[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.post("/api/auth/forgot-password", (req, res) => {
  const { email } = req.body ?? {};
  if (email) {
    const token = requestPasswordReset(email);
    if (token) {
      const origin = `${req.protocol}://${req.get("host")}`;
      const resetUrl = `${origin}/?reset_token=${token}`;
      // Always logged too — cheap, and a fallback if SMTP is down/unconfigured.
      console.log(`[auth] password reset requested for ${email}: ${resetUrl} (valid 1h)`);
      sendPasswordResetEmail(email, resetUrl).catch((err) => console.warn(`[mail] send failed: ${err.message}`));
    }
  }
  // Identical response whether or not the email matched — never confirm
  // or deny that an address is the admin account.
  res.json({ ok: true, message: "If that email is registered, a reset link has been generated." });
});

app.post("/api/auth/reset-password", (req, res) => {
  const { token, newPassword } = req.body ?? {};
  if (!token || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "token and a password of at least 8 characters are required" });
  }
  const ok = resetPassword(token, newPassword);
  if (!ok) return res.status(400).json({ error: "invalid or expired reset link" });
  res.json({ ok: true });
});

// ── Alexa Routine trigger ────────────────────────────────────────────────
// See server/src/alexaSkill.js's header comment for the full picture. Two
// routes below (/oauth/authorize, /oauth/token) implement account
// linking — this server acts as its own OAuth identity provider, gated
// behind the same admin password as everything else, rather than standing
// up a second login system. The other two are the actual feature surface:
// an internal endpoint only the Lambda calls, and the one the dashboard's
// "AC Boost" button calls.

/** A deliberately tiny, self-contained HTML page — this is a one-time,
 * infrequent flow (linking the skill), not worth wiring into the React
 * SPA. Reuses the exact same password check as the real login. */
function renderAuthorizePage({ clientId, redirectUri, state, error }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Link Ohm Sweet Ohm</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, sans-serif; background: #f0f0ee; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  form { background: #fff; border-radius: 14px; padding: 28px; width: 100%; max-width: 340px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  h1 { font-size: 17px; margin: 0 0 6px; }
  p { font-size: 13px; color: #666; margin: 0 0 20px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #444; margin-bottom: 5px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 10px; margin-bottom: 14px; border: 1px solid #ccc; border-radius: 8px; font-size: 14px; }
  button { width: 100%; padding: 10px; background: #2a78d6; color: #fff; border: none; border-radius: 8px; font-weight: 700; font-size: 14px; cursor: pointer; }
  .error { color: #c0392b; font-size: 13px; margin: -10px 0 14px; }
</style></head>
<body>
  <form method="POST" action="/oauth/authorize">
    <h1>Link Ohm Sweet Ohm to Alexa</h1>
    <p>Sign in with your dashboard admin account to allow Alexa to trigger routines.</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${state ?? ""}">
    <label>Email</label>
    <input type="email" name="email" required autofocus>
    <label>Password</label>
    <input type="password" name="password" required>
    <button type="submit">Link account</button>
  </form>
</body></html>`;
}

function handleAuthorize(req, res) {
  const { client_id: clientId, redirect_uri: redirectUri, state, response_type: responseType } = { ...req.query, ...req.body };
  if (responseType && responseType !== "code") return res.status(400).send("unsupported response_type");
  if (!redirectUri) return res.status(400).send("missing redirect_uri");

  if (req.method === "GET") {
    return res.type("html").send(renderAuthorizePage({ clientId, redirectUri, state }));
  }

  // POST: the login form submission.
  const { email, password } = req.body ?? {};
  const result = login(email, password);
  if (!result) {
    return res.type("html").send(renderAuthorizePage({ clientId, redirectUri, state, error: "Incorrect email or password." }));
  }
  const code = createAuthorizationCode(redirectUri);
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
}
app.get("/oauth/authorize", handleAuthorize);
app.post("/oauth/authorize", express.urlencoded({ extended: false }), handleAuthorize);

/** Alexa's server (not the user's browser) calls this directly to exchange a code, or later to refresh — standard OAuth token endpoint, form-encoded per spec. */
app.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
  const { grant_type: grantType, code, redirect_uri: redirectUri, refresh_token: refreshToken } = req.body ?? {};
  let tokens = null;
  if (grantType === "authorization_code") {
    tokens = exchangeAuthorizationCode(code, redirectUri);
  } else if (grantType === "refresh_token") {
    tokens = refreshLinkToken(refreshToken);
  } else {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }
  if (!tokens) return res.status(400).json({ error: "invalid_grant" });
  res.json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "bearer",
    expires_in: 3600,
  });
});

/** Called only by the Lambda (alexa-skill/index.js), right after it exchanges Alexa's AcceptGrant code with LWA — relays the resulting user-scoped token here so the main server can use it to send proactive events. */
app.post("/api/internal/alexa/store-grant", (req, res) => {
  if (req.headers["x-internal-secret"] !== process.env.ALEXA_INTERNAL_SECRET || !process.env.ALEXA_INTERNAL_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { accessToken, refreshToken, expiresIn } = req.body ?? {};
  if (!accessToken || !refreshToken || !expiresIn) return res.status(400).json({ error: "accessToken, refreshToken, expiresIn required" });
  storeGrantToken({ accessToken, refreshToken, expiresIn });
  res.json({ ok: true });
});

app.get("/api/alexa/status", requireAuth, (_req, res) => {
  res.json({ linked: isAccountLinked() });
});

/** The dashboard's "AC Boost" button. */
app.post("/api/alexa/trigger", requireAuth, async (_req, res) => {
  try {
    await triggerRoutine();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.put("/api/channels/:index", requireAuth, (req, res) => {
  const { label, kind, factor } = req.body ?? {};
  if (label === undefined && kind === undefined && factor === undefined) {
    return res.status(400).json({ error: "provide label, kind, and/or factor" });
  }
  const updated = updateChannel(req.params.index, { label, kind, factor });
  if (!updated) return res.status(400).json({ error: "invalid channel index, kind, or factor" });

  // Re-decorate the live reading so connected dashboards see the rename/
  // reclassification immediately, without waiting for the next MQTT tick.
  if (latestReading) {
    latestReading = withGridDirection(latestReading);
    broadcast({ type: "live", data: latestReading });
  }
  broadcast({ type: "channels", data: getChannelList() });
  res.json(updated);
});

app.get("/api/live", (_req, res) => {
  if (!latestReading) return res.status(503).json({ error: "no reading yet" });
  res.json(latestReading);
});

app.get("/api/today-snapshot", async (_req, res) => {
  const location = getWeatherLocation();
  const timezone = getConfiguredTimezone();
  const list = getChannelList();

  let sunWindow = null;
  if (location) {
    try {
      sunWindow = await getSunWindow(localDateStr(Date.now(), timezone), location);
    } catch (err) {
      console.warn(`[weather] sun window lookup failed: ${err.message}`);
    }
  }

  const snapshot = todaySnapshot({
    channelKinds: list.map((c) => c.kind),
    channelLabels: list.map((c) => c.label),
    timezone,
    sunWindow,
  });

  let warmest = null;
  try {
    warmest = await getTodayWarmest(snapshot.dayStart, Date.now());
  } catch (err) {
    console.warn(`[weather] today-snapshot warmest lookup failed: ${err.message}`);
  }

  res.json({
    ...snapshot,
    timezone,
    location: location ? { city: location.city, state: location.state } : null,
    warmest,
    sunWindow,
  });
});

// Daily Snapshots history page: a month calendar (this route — one figure
// per day, no per-day weather lookup, so a month stays one cheap query)
// plus a detail view for whichever day gets selected (the next route).
app.get("/api/daily-snapshots", async (req, res) => {
  const to = req.query.to ? Number(req.query.to) : Date.now();
  const from = req.query.from ? Number(req.query.from) : to - 31 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return res.status(400).json({ error: "invalid from/to" });
  }
  const location = getWeatherLocation();
  const timezone = getConfiguredTimezone();
  const list = getChannelList();

  // Cap at "now" *before* the sun-windows lookup, not after — a "current
  // month" view's nominal end date is always still in the future, which
  // never has a cached entry (getSunWindowsForRange only skips its network
  // call when both ends of the range are cached), so every single page
  // load was making a live Open-Meteo request for a date range that was
  // never going to be used past `rangeEnd` anyway. Harmless on a healthy
  // network, but a real liability piled on top of an already-struggling
  // one (see README's incident notes).
  const rangeEnd = Math.min(to, Date.now());

  let sunWindows = new Map();
  if (location) {
    try {
      sunWindows = await getSunWindowsForRange(localDateStr(from, timezone), localDateStr(rangeEnd, timezone), location);
    } catch (err) {
      console.warn(`[weather] sun windows range lookup failed: ${err.message}`);
    }
  }

  const days = dailySnapshots({
    from,
    to: rangeEnd,
    channelKinds: list.map((c) => c.kind),
    channelLabels: list.map((c) => c.label),
    timezone,
    sunWindows,
  });

  // Warmest per day, batched: one hourly-temp fetch for the whole range
  // (already cached/efficient — see getHourlyTemps) rather than one request
  // per day. The archive it reads from lags a day or two behind real time,
  // so "today" (if it's in range) is patched in separately via the
  // forecast-sourced path used by /api/today-snapshot.
  const warmestByDate = new Map();
  if (location) {
    try {
      const temps = await getHourlyTemps(from, rangeEnd);
      for (const t of temps) {
        const ds = localDateStr(t.ts, timezone);
        const cur = warmestByDate.get(ds);
        if (!cur || t.tempF > cur.tempF) warmestByDate.set(ds, { tempF: t.tempF, ts: t.ts });
      }
      const todayStr = localDateStr(Date.now(), timezone);
      if (days.some((d) => d.date === todayStr)) {
        const todayStart = localDateToUtcMs(todayStr, timezone);
        const tw = await getTodayWarmest(todayStart, Date.now());
        if (tw) warmestByDate.set(todayStr, tw);
      }
    } catch (err) {
      console.warn(`[weather] daily warmest batch lookup failed: ${err.message}`);
    }
  }

  const daysWithWarmest = days.map((d) => ({ ...d, warmest: warmestByDate.get(d.date) ?? null }));

  res.json({ days: daysWithWarmest, timezone, location: location ? { city: location.city, state: location.state } : null });
});

app.get("/api/day-snapshot", async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }
  const location = getWeatherLocation();
  const timezone = getConfiguredTimezone();
  const list = getChannelList();

  let sunWindow = null;
  if (location) {
    try {
      sunWindow = await getSunWindow(date, location);
    } catch (err) {
      console.warn(`[weather] sun window lookup failed for ${date}: ${err.message}`);
    }
  }

  const dayStart = localDateToUtcMs(date, timezone);
  const dayEnd = Math.min(dayStart + 24 * 3600 * 1000, Date.now());

  const [snapshot] = dailySnapshots({
    from: dayStart,
    to: dayEnd,
    channelKinds: list.map((c) => c.kind),
    channelLabels: list.map((c) => c.label),
    timezone,
    sunWindows: sunWindow ? new Map([[date, sunWindow]]) : new Map(),
  });

  const result =
    snapshot ??
    { date, dayStart, sampleCount: 0, producedKwh: 0, gridImportKwh: 0, totalKwh: 0, biggestCircuit: null, peak: null };

  let warmest = null;
  if (location) {
    try {
      const todayStr = localDateStr(Date.now(), timezone);
      warmest =
        date === todayStr
          ? await getTodayWarmest(dayStart, Date.now())
          : await getDayWarmest(dayStart, dayStart + 24 * 3600 * 1000);
    } catch (err) {
      console.warn(`[weather] day-snapshot warmest lookup failed: ${err.message}`);
    }
  }

  res.json({
    ...result,
    timezone,
    location: location ? { city: location.city, state: location.state } : null,
    warmest,
    sunWindow,
  });
});

app.get("/api/history", (req, res) => {
  const to = req.query.to ? Number(req.query.to) : Date.now();
  const from = req.query.from ? Number(req.query.from) : to - 15 * 60 * 1000;
  const points = req.query.points ? Number(req.query.points) : 300;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return res.status(400).json({ error: "invalid from/to" });
  }
  res.json({ from, to, points: queryHistory({ from, to, points }) });
});

app.get("/api/summary", (req, res) => {
  const to = req.query.to ? Number(req.query.to) : Date.now();
  const from = req.query.from ? Number(req.query.from) : to - 15 * 60 * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return res.status(400).json({ error: "invalid from/to" });
  }
  const channel = req.query.channel !== undefined ? Number(req.query.channel) : undefined;
  if (channel !== undefined && (!Number.isInteger(channel) || channel < 0 || channel >= 19)) {
    return res.status(400).json({ error: "invalid channel" });
  }
  res.json(querySummary({ from, to, channel }));
});

app.get("/api/analytics", async (req, res) => {
  const to = req.query.to ? Number(req.query.to) : Date.now();
  const from = req.query.from ? Number(req.query.from) : to - 24 * 60 * 60 * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return res.status(400).json({ error: "invalid from/to" });
  }
  const list = getChannelList();
  res.json(
    await computeAnalytics({
      from,
      to,
      channelKinds: list.map((c) => c.kind),
      channelLabels: list.map((c) => c.label),
      timezone: getConfiguredTimezone(),
    })
  );
});

app.get("/api/settings/weather", (_req, res) => {
  res.json({ location: getWeatherLocation() });
});

app.put("/api/settings/weather", requireAuth, async (req, res) => {
  const { zip } = req.body ?? {};
  if (!zip || !/^\d{5}$/.test(String(zip))) {
    return res.status(400).json({ error: "provide a 5-digit US zip code" });
  }
  try {
    const backfillFrom = new Date(new Date().getFullYear(), 5, 1, 0, 0, 0, 0).getTime(); // June 1 this year
    const location = await setWeatherZip(String(zip), backfillFrom);
    if (!location) return res.status(400).json({ error: "couldn't resolve that zip code" });
    res.json({ location });
  } catch (err) {
    res.status(502).json({ error: `zip lookup failed: ${err.message}` });
  }
});

app.get("/api/push/vapid-public-key", (_req, res) => {
  res.json({ publicKey: pushReady() ? process.env.VAPID_PUBLIC_KEY : null });
});

// Subscribing/unsubscribing is per-device, not an admin action — anyone
// viewing the dashboard can opt this browser in, the same way they could
// just turn notifications off in their OS if they didn't want them.
app.post("/api/push/subscribe", (req, res) => {
  try {
    addSubscription(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/push/unsubscribe", (req, res) => {
  removeSubscription(req.body?.endpoint);
  res.json({ ok: true });
});

app.get("/api/settings/alerts", (_req, res) => {
  res.json(getAlertSettings());
});

app.put("/api/settings/alerts", requireAuth, (req, res) => {
  const { enabled, thresholdPct } = req.body ?? {};
  if (thresholdPct !== undefined && (!Number.isFinite(thresholdPct) || thresholdPct < 5 || thresholdPct > 500)) {
    return res.status(400).json({ error: "thresholdPct must be between 5 and 500" });
  }
  const patch = {};
  if (enabled !== undefined) patch.enabled = !!enabled;
  if (thresholdPct !== undefined) patch.thresholdPct = Number(thresholdPct);
  res.json(setAlertSettings(patch));
});

app.get("/api/settings/billing", (_req, res) => {
  res.json(getBillingSettings());
});

app.put("/api/settings/billing", requireAuth, (req, res) => {
  const { solarBillingDay, electricBillingDay, electricReadDates } = req.body ?? {};
  const patch = {};
  if (electricReadDates !== undefined) {
    const valid =
      Array.isArray(electricReadDates) &&
      electricReadDates.every((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)));
    if (!valid) return res.status(400).json({ error: "electricReadDates must be a list of YYYY-MM-DD dates" });
    patch.electricReadDates = [...new Set(electricReadDates)].sort();
  }
  for (const [key, val] of [
    ["solarBillingDay", solarBillingDay],
    ["electricBillingDay", electricBillingDay],
  ]) {
    if (val === undefined) continue;
    if (!Number.isInteger(val) || val < 1 || val > 28) {
      return res.status(400).json({ error: `${key} must be an integer between 1 and 28` });
    }
    patch[key] = val;
  }
  res.json(setBillingSettings(patch));
});

// Cost/tier estimate for an arbitrary [from, to) period — used by the
// Daily Snapshots page's billing-cycle cost tracker. The caller (already
// computing the period boundaries locally to match its billing-mode
// toggle) passes them straight through; this doesn't re-derive a cycle
// itself, so it works the same whether the selected period is the real
// electric billing cycle, the solar one, or just a calendar month.
//
// When [from, to) is exactly the current electric billing cycle — what the
// page shows by default — this is a plain cache read (see
// scheduledJobs.js's 15-min timer + billingCost.js's currentCycleCache):
// no dailySnapshots() scan on the request path, so it can't get queued
// behind the hourly analytics job the way a live computation could. Any
// other range (a past cycle via prev/next, or calendar/solar mode) still
// computes on request — those are hit far less often and, for a past
// (fully elapsed) cycle, cheap regardless (every day is already cached in
// daily_snapshots).
app.get("/api/billing/cost-estimate", (req, res) => {
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return res.status(400).json({ error: "invalid from/to" });
  }
  const cached = getCachedCycleCost(from, to);
  if (cached) return res.json({ ...cached.estimate, computedAt: cached.computedAt });

  const timezone = getConfiguredTimezone();
  const list = getChannelList();
  const estimate = estimatePeriodCost({
    fromMs: from,
    toMs: to,
    timezone,
    channelKinds: list.map((c) => c.kind),
    channelLabels: list.map((c) => c.label),
  });
  res.json({ ...estimate, computedAt: Date.now() });
});

function calibrationSettings() {
  const { gain, offsetW } = getImportCorrection();
  return { factor: getCalibrationFactor(), importGain: gain, importOffsetW: offsetW };
}

app.get("/api/settings/calibration", (_req, res) => {
  res.json(calibrationSettings());
});

app.put("/api/settings/calibration", requireAuth, (req, res) => {
  const { factor, importGain, importOffsetW } = req.body ?? {};
  if (factor !== undefined && (!Number.isFinite(factor) || factor <= 0 || factor > 10)) {
    return res.status(400).json({ error: "factor must be a number between 0 and 10" });
  }
  if (importGain !== undefined || importOffsetW !== undefined) {
    const current = getImportCorrection();
    const gain = importGain ?? current.gain;
    const offsetW = importOffsetW ?? current.offsetW;
    if (!Number.isFinite(gain) || gain < 0.5 || gain > 2 || !Number.isFinite(offsetW) || Math.abs(offsetW) > 1000) {
      return res.status(400).json({ error: "import gain must be 0.5-2 and offset within ±1000 W" });
    }
    setImportCorrection({ gain, offsetW });
  }
  if (factor !== undefined) setCalibrationFactor(factor);
  res.json(calibrationSettings());
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Admin-only even for GET, unlike the other settings above — this one
// echoes back a personal email address, not just a knob position.
app.get("/api/settings/daily-email", requireAuth, (_req, res) => {
  res.json(getDailyEmailSettings());
});

app.put("/api/settings/daily-email", requireAuth, (req, res) => {
  const { enabled, address } = req.body ?? {};
  if (address !== undefined && !EMAIL_RE.test(String(address))) {
    return res.status(400).json({ error: "provide a valid email address" });
  }
  const patch = {};
  if (enabled !== undefined) patch.enabled = !!enabled;
  if (address !== undefined) patch.address = String(address).trim();
  res.json(setDailyEmailSettings(patch));
});

// Sends today's-most-recently-completed-day report right now, ignoring the
// enabled toggle (but still to whatever address is configured) — lets an
// admin confirm delivery/rendering without waiting for the next rollover.
app.post("/api/settings/daily-email/test", requireAuth, async (req, res) => {
  try {
    const timezone = getConfiguredTimezone();
    const todayStr = localDateStr(Date.now(), timezone);
    const dateStr = req.body?.date || dayBeforeStr(todayStr);
    const location = getWeatherLocation();
    const channels = getChannelList();
    await sendTestDailyReport(dateStr, {
      channelKinds: channels.map((c) => c.kind),
      channelLabels: channels.map((c) => c.label),
      timezone,
      location,
    });
    res.json({ ok: true, date: dateStr, address: getDailyEmailSettings().address });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Pearson correlation coefficient, or null if there's not enough variance/data to compute one. */
function pearsonCorrelation(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0,
    sumY2 = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }
  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

app.get("/api/weather-correlation", async (req, res) => {
  const to = req.query.to ? Number(req.query.to) : Date.now();
  const from = req.query.from ? Number(req.query.from) : to - 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return res.status(400).json({ error: "invalid from/to" });
  }
  const location = getWeatherLocation();
  if (!location) return res.json({ location: null, points: [], correlation: null });

  try {
    const temps = await getHourlyTemps(from, to);
    const tempByHour = new Map(temps.map((t) => [t.ts, t.tempF]));
    const consumptionByHour = hourlyConsumption({
      from,
      to,
      channelKinds: getChannelList().map((c) => c.kind),
      timezone: getConfiguredTimezone(),
    });
    const points = consumptionByHour
      .filter((p) => tempByHour.has(p.ts))
      .map((p) => ({
        ts: p.ts,
        tempF: tempByHour.get(p.ts),
        avgPower: p.totalPower,
        gridPower: p.gridPower,
        solarPower: p.solarPower,
      }))
      .sort((a, b) => a.ts - b.ts);
    const correlation = pearsonCorrelation(points.map((p) => [p.tempF, p.avgPower]));
    res.json({ location, points, correlation });
  } catch (err) {
    res.status(502).json({ error: `weather lookup failed: ${err.message}` });
  }
});

app.get("/api/weather-daily", async (req, res) => {
  const to = req.query.to ? Number(req.query.to) : Date.now();
  const from = req.query.from ? Number(req.query.from) : to - 30 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return res.status(400).json({ error: "invalid from/to" });
  }
  const location = getWeatherLocation();
  if (!location) return res.json({ location: null, days: [], correlation: null, hottestDay: null, mildestDay: null });

  try {
    const temps = await getHourlyTemps(from, to);
    const tempsByDate = new Map(); // dateStr -> temps[]
    for (const t of temps) {
      const ds = new Date(t.ts).toLocaleDateString("en-CA"); // YYYY-MM-DD, local
      let arr = tempsByDate.get(ds);
      if (!arr) {
        arr = [];
        tempsByDate.set(ds, arr);
      }
      arr.push(t.tempF);
    }

    const consumption = dailyConsumption({
      from,
      to,
      channelKinds: getChannelList().map((c) => c.kind),
      timezone: getConfiguredTimezone(),
    });
    const days = consumption
      .filter((d) => tempsByDate.has(d.date))
      .map((d) => {
        const dayTemps = tempsByDate.get(d.date);
        const avgTempF = dayTemps.reduce((s, t) => s + t, 0) / dayTemps.length;
        return {
          date: d.date,
          avgTempF: Math.round(avgTempF * 10) / 10,
          minTempF: Math.round(Math.min(...dayTemps) * 10) / 10,
          maxTempF: Math.round(Math.max(...dayTemps) * 10) / 10,
          totalKwh: d.totalKwh,
          gridImportKwh: d.gridImportKwh,
          solarKwh: d.solarKwh,
        };
      });

    const correlation = pearsonCorrelation(days.map((d) => [d.avgTempF, d.totalKwh]));
    const hottestDay = days.length ? days.reduce((a, b) => (b.avgTempF > a.avgTempF ? b : a)) : null;
    const mildestDay = days.length ? days.reduce((a, b) => (b.avgTempF < a.avgTempF ? b : a)) : null;

    res.json({ location, days, correlation, hottestDay, mildestDay });
  } catch (err) {
    res.status(502).json({ error: `weather lookup failed: ${err.message}` });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "status", data: mqttStatus }));
  if (latestReading) socket.send(JSON.stringify({ type: "live", data: latestReading }));
});

const bus = startMqttIngest({
  host: MQTT_HOST,
  port: Number(MQTT_PORT),
  username: SEMMETER_USER,
  password: SEMMETER_PASS,
  deviceSn: DEVICE_SN,
  getCalibrationFactor,
  getCircuitFactors: getChannelFactors,
});

bus.on("status", (status) => {
  mqttStatus = status;
  console.log(`[mqtt] ${status.state}${status.detail ? " - " + status.detail : ""}`);
  broadcast({ type: "status", data: status });
});

bus.on("reading", (reading) => {
  latestReading = withGridDirection(reading);
  const channelKinds = getChannelList().map((c) => c.kind);
  const timezone = getConfiguredTimezone();
  addReading(latestReading, channelKinds, timezone);
  broadcast({ type: "live", data: latestReading });
  maybeCheckUsage(channelKinds, timezone).catch((err) => console.warn(`[alerts] check failed: ${err.message}`));
  refreshSunWindowCache().catch((err) => console.warn(`[weather] sun window refresh failed: ${err.message}`)); // no-op unless the calendar day just rolled over
  maybeRollupYesterday().catch((err) => console.warn(`[store] daily snapshot rollup failed: ${err.message}`)); // no-op unless the calendar day just rolled over
});

startScheduledJobs(() => {
  const list = getChannelList();
  return {
    channelKinds: list.map((c) => c.kind),
    channelLabels: list.map((c) => c.label),
    timezone: getConfiguredTimezone(),
    location: getWeatherLocation(),
  };
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (device ${DEVICE_SN})`);
});

process.on("SIGINT", () => {
  bus.close?.();
  process.exit(0);
});
