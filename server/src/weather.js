// Outdoor temperature correlation: zip -> lat/lon via Zippopotam.us, hourly
// historical temps via Open-Meteo's archive API. Both are free, keyless,
// no signup — matching the rest of this project's "no new paid dependency"
// approach. Resolved location + fetched hours are cached in SQLite so we
// never re-fetch an hour that's already on disk.
import { db } from "./db.js";
import { dayStartUtcMs, localIsoToUtcMs, localDateStr } from "./tz.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS weather_hourly (
    hour_ts INTEGER PRIMARY KEY,
    temp_f REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sun_times (
    date TEXT PRIMARY KEY,
    sunrise_ts INTEGER NOT NULL,
    sunset_ts INTEGER NOT NULL
  );
`);

const getSettingStmt = db.prepare("SELECT value FROM app_settings WHERE key = ?");
const setSettingStmt = db.prepare(
  "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);
const insertHourStmt = db.prepare("INSERT OR REPLACE INTO weather_hourly (hour_ts, temp_f) VALUES (?, ?)");
const rangeHourStmt = db.prepare("SELECT hour_ts, temp_f FROM weather_hourly WHERE hour_ts >= ? AND hour_ts <= ? ORDER BY hour_ts");
const hasHourStmt = db.prepare("SELECT 1 FROM weather_hourly WHERE hour_ts = ?");
const getSunStmt = db.prepare("SELECT sunrise_ts, sunset_ts FROM sun_times WHERE date = ?");
const insertSunStmt = db.prepare("INSERT OR REPLACE INTO sun_times (date, sunrise_ts, sunset_ts) VALUES (?, ?, ?)");

export function getWeatherLocation() {
  const row = getSettingStmt.get("weather_location");
  return row ? JSON.parse(row.value) : null;
}

/** The zip's own IANA timezone if one's configured (and resolved OK),
 * otherwise this server's own — used so "today" means the zip's calendar
 * day, not necessarily this VM's (which runs UTC). */
export function getConfiguredTimezone() {
  return getWeatherLocation()?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** IANA timezone name for a lat/lon, via Open-Meteo's own `timezone=auto`
 * resolution (free, keyless, no separate geo-timezone API needed) — null on
 * any failure, callers should fall back to the server's own timezone. */
async function resolveTimezone(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=1&hourly=temperature_2m`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.timezone ?? null;
  } catch {
    return null;
  }
}

async function resolveZip(zip) {
  const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
  if (!res.ok) return null;
  const data = await res.json();
  const place = data.places?.[0];
  if (!place) return null;
  const lat = Number(place.latitude);
  const lon = Number(place.longitude);
  return {
    zip,
    lat,
    lon,
    city: place["place name"],
    state: place["state abbreviation"],
    timezone: await resolveTimezone(lat, lon),
  };
}

/**
 * Resolves and persists a new zip code, then eagerly backfills the cache
 * for [backfillFrom, now] in one request so historical charts have data
 * immediately instead of filling in only as each range gets viewed.
 * Returns the resolved location, or null if the zip didn't resolve.
 */
export async function setWeatherZip(zip, backfillFrom) {
  const location = await resolveZip(zip);
  if (!location) return null;
  setSettingStmt.run("weather_location", JSON.stringify(location));
  if (backfillFrom) await getHourlyTemps(backfillFrom, Date.now());
  return location;
}

function hourStartTs(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function dateOnly(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchAndCacheRange(location, startDate, endDate) {
  const tz = location.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${location.lat}&longitude=${location.lon}` +
    `&start_date=${dateOnly(startDate)}&end_date=${dateOnly(endDate)}` +
    `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=${encodeURIComponent(tz)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo request failed: HTTP ${res.status}`);
  const data = await res.json();
  const times = data.hourly?.time ?? [];
  const temps = data.hourly?.temperature_2m ?? [];
  for (let i = 0; i < times.length; i++) {
    // times[i] is a bare "YYYY-MM-DDTHH:mm" labeled in `tz`, with no offset
    // — `new Date(...)` would parse that in *this server's* local timezone
    // instead, which is wrong whenever tz isn't also this VM's own (UTC).
    if (Number.isFinite(temps[i])) insertHourStmt.run(localIsoToUtcMs(times[i], tz), temps[i]);
  }
}

/**
 * Returns [{ts, tempF}] for each local hour in [from, to] that has (or can
 * get) data, fetching+caching any hours not already on disk. Returns [] if
 * no zip is configured yet. Open-Meteo's archive only has data up to a
 * couple days behind real time, so very recent hours may just be absent —
 * see getTodayWarmest() below for "right now"-ish data instead.
 */
export async function getHourlyTemps(from, to) {
  const location = getWeatherLocation();
  if (!location) return [];

  const startHour = hourStartTs(from);
  const endHour = hourStartTs(to);

  let missingMin = null,
    missingMax = null;
  for (let t = startHour; t <= endHour; t += 3_600_000) {
    if (!hasHourStmt.get(t)) {
      if (missingMin === null) missingMin = t;
      missingMax = t;
    }
  }
  if (missingMin !== null) {
    await fetchAndCacheRange(location, new Date(missingMin), new Date(missingMax));
  }

  return rangeHourStmt.all(startHour, endHour).map((r) => ({ ts: r.hour_ts, tempF: r.temp_f }));
}

let lastTodayFetchTs = 0;
const TODAY_FETCH_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Fetches (and caches) today's hourly temps so far via Open-Meteo's
 * *forecast* endpoint rather than the archive one — the archive lags a day
 * or two behind real time, so it never has "today." Throttled to once per
 * 5 minutes regardless of how often it's called; today's warmest-so-far
 * doesn't need second-level freshness, and this keeps repeated polling
 * (the frontend refreshes the snapshot card periodically) from hammering
 * Open-Meteo.
 */
async function fetchAndCacheToday(location) {
  const now = Date.now();
  if (now - lastTodayFetchTs < TODAY_FETCH_THROTTLE_MS) return;
  lastTodayFetchTs = now;

  const tz = location.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lon}` +
    `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=${encodeURIComponent(tz)}&past_days=1&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo forecast request failed: HTTP ${res.status}`);
  const data = await res.json();
  const times = data.hourly?.time ?? [];
  const temps = data.hourly?.temperature_2m ?? [];
  for (let i = 0; i < times.length; i++) {
    if (Number.isFinite(temps[i])) insertHourStmt.run(localIsoToUtcMs(times[i], tz), temps[i]);
  }
}

/**
 * Warmest cached hour in [dayStartMs, nowMs] — "today's warmest so far,"
 * fetching today's forecast-sourced temps first since the archive cache
 * (used everywhere else) never has "today." Returns null if no zip is
 * configured, or nothing's cached yet for today.
 */
export async function getTodayWarmest(dayStartMs, nowMs) {
  const location = getWeatherLocation();
  if (!location) return null;
  try {
    await fetchAndCacheToday(location);
  } catch (err) {
    console.warn(`[weather] today fetch failed, using whatever's cached: ${err.message}`);
  }
  const rows = rangeHourStmt.all(dayStartMs, nowMs);
  if (rows.length === 0) return null;
  let best = rows[0];
  for (const r of rows) if (r.temp_f > best.temp_f) best = r;
  return { tempF: best.temp_f, ts: best.hour_ts };
}

/**
 * Sunrise/sunset are pure astronomy (no observation lag the way temperature
 * has), so unlike getTodayWarmest above, the archive endpoint alone covers
 * both historical dates and today/future ones — no separate forecast path
 * needed. Caches by local calendar date (in `timezone`).
 */
async function fetchAndCacheSunTimes(location, fromDateStr, toDateStr) {
  const tz = location.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${location.lat}&longitude=${location.lon}` +
    `&start_date=${fromDateStr}&end_date=${toDateStr}&daily=sunrise,sunset&timezone=${encodeURIComponent(tz)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo sun-times request failed: HTTP ${res.status}`);
  const data = await res.json();
  const dates = data.daily?.time ?? [];
  const sunrises = data.daily?.sunrise ?? [];
  const sunsets = data.daily?.sunset ?? [];
  for (let i = 0; i < dates.length; i++) {
    if (sunrises[i] && sunsets[i]) {
      insertSunStmt.run(dates[i], localIsoToUtcMs(sunrises[i], tz), localIsoToUtcMs(sunsets[i], tz));
    }
  }
}

/**
 * Sunrise/sunset (as UTC ms) for one local calendar date, fetching+caching
 * on a cache miss. Returns null if no zip is configured, or the fetch
 * failed and nothing was cached for that date yet — callers should treat
 * that as "can't tell, don't reclassify" rather than assuming day or night.
 */
export async function getSunWindow(dateStr, location) {
  if (!location) return null;
  let row = getSunStmt.get(dateStr);
  if (!row) {
    try {
      await fetchAndCacheSunTimes(location, dateStr, dateStr);
    } catch (err) {
      console.warn(`[weather] sun-times fetch failed for ${dateStr}: ${err.message}`);
      return null;
    }
    row = getSunStmt.get(dateStr);
  }
  return row ? { sunriseTs: row.sunrise_ts, sunsetTs: row.sunset_ts } : null;
}

/**
 * Sunrise/sunset for every local date in [fromDateStr, toDateStr], as a
 * Map<date, {sunriseTs, sunsetTs}> — one Open-Meteo request for the whole
 * range instead of one per day, for the Daily Snapshots month view. Only
 * fetches if the range's first or last date is missing from the cache
 * (good enough: sun_times is populated date-by-date with INSERT OR REPLACE,
 * so a previously-viewed month is already fully cached and this skips
 * straight to the DB read).
 */
export async function getSunWindowsForRange(fromDateStr, toDateStr, location) {
  if (!location) return new Map();
  const hasFirst = getSunStmt.get(fromDateStr);
  const hasLast = getSunStmt.get(toDateStr);
  if (!hasFirst || !hasLast) {
    try {
      await fetchAndCacheSunTimes(location, fromDateStr, toDateStr);
    } catch (err) {
      console.warn(`[weather] sun-times range fetch failed for ${fromDateStr}..${toDateStr}: ${err.message}`);
    }
  }
  const rows = db
    .prepare("SELECT date, sunrise_ts, sunset_ts FROM sun_times WHERE date >= ? AND date <= ?")
    .all(fromDateStr, toDateStr);
  return new Map(rows.map((r) => [r.date, { sunriseTs: r.sunrise_ts, sunsetTs: r.sunset_ts }]));
}

/**
 * Warmest hour in [dayStartMs, dayEndMs] for a *completed* historical day —
 * the archive cache (used everywhere except "today," see getTodayWarmest
 * above) already has it, or can fetch it via the normal historical path.
 * Returns null if no zip is configured or nothing's available.
 */
export async function getDayWarmest(dayStartMs, dayEndMs) {
  if (!getWeatherLocation()) return null;
  const temps = await getHourlyTemps(dayStartMs, dayEndMs).catch(() => []);
  if (temps.length === 0) return null;
  let best = temps[0];
  for (const t of temps) if (t.tempF > best.tempF) best = t;
  return { tempF: best.tempF, ts: best.ts };
}

export { dayStartUtcMs, localDateStr };
