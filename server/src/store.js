import { CIRCUIT_COUNT, MAIN_INDEXES } from "./channels.js";
import { db } from "./db.js";
import { dayStartUtcMs, isWithinDaylight, localDateStr, localDateToUtcMs, localHour, localHourStartUtcMs, localWeekday } from "./tz.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    tp REAL NOT NULL,
    p TEXT NOT NULL,
    eIn TEXT NOT NULL,
    eOut TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

  -- Per-minute averages of the raw readings (n = raw samples in that
  -- minute, so coarser buckets can be re-averaged exactly, weighted by n).
  -- Long-range history charts read this instead of scanning ~43k raw rows
  -- per day — see queryHistory(). Derived data: always rebuildable from
  -- the readings table with scripts/backfill-minute-agg.js.
  CREATE TABLE IF NOT EXISTS readings_1m (
    ts INTEGER PRIMARY KEY,
    n INTEGER NOT NULL,
    tp REAL NOT NULL,
    p TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT PRIMARY KEY,
    weekday INTEGER NOT NULL,
    sampleCount INTEGER NOT NULL,
    avgGridPower REAL NOT NULL,
    avgHouseholdPower REAL NOT NULL,
    importKwh REAL NOT NULL,
    exportKwh REAL NOT NULL,
    netKwh REAL NOT NULL
  );

  -- One row per completed local calendar day — the same fields
  -- computeSnapshotFromRows() produces, cached so the Daily Snapshots page
  -- doesn't re-scan that day's raw readings on every single page view. Only
  -- ever written for days that are over (see dailySnapshots() below); today
  -- is still changing, so it's always computed fresh, never cached here.
  CREATE TABLE IF NOT EXISTS daily_snapshots (
    date TEXT PRIMARY KEY,
    sampleCount INTEGER NOT NULL,
    producedKwh REAL NOT NULL,
    gridImportKwh REAL NOT NULL,
    gridExportKwh REAL NOT NULL DEFAULT 0,
    totalKwh REAL NOT NULL,
    biggestCircuitIndex INTEGER,
    biggestCircuitLabel TEXT,
    biggestCircuitKwh REAL,
    peakTs INTEGER,
    peakTotalPower REAL,
    peakGridPower REAL,
    peakSolarPower REAL,
    peakProductionTs INTEGER,
    peakProductionW REAL
  );
`);

// daily_snapshots gained peakProduction*/gridExportKwh after its first
// release — a plain migration for what's purely a cache table (every row
// is cheaply recomputable from raw readings, so there's no data to lose or
// migrate,
// just columns to add to installs that created the table before this
// existed). ALTER TABLE has no "ADD COLUMN IF NOT EXISTS", so this just
// tries it and swallows the "duplicate column" error on installs that
// already have it (including brand new ones, where CREATE TABLE above
// just created it with the column already present).
for (const col of ["peakProductionTs INTEGER", "peakProductionW REAL", "gridExportKwh REAL NOT NULL DEFAULT 0"]) {
  try {
    db.exec(`ALTER TABLE daily_snapshots ADD COLUMN ${col}`);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}

const insertReadingStmt = db.prepare("INSERT INTO readings (ts, tp, p, eIn, eOut) VALUES (?, ?, ?, ?, ?)");

// ── Short-lived result cache ────────────────────────────────────────────
// Everything below that scans raw rows is synchronous (node:sqlite) — it
// blocks the whole event loop, so N identical requests in a row cost N full
// scans back to back. A few seconds of memoization collapses concurrent
// clients / tabs / repeat polls into one scan.
const memoCache = new Map();
function memo(key, ttlMs, fn) {
  const now = Date.now();
  const hit = memoCache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = fn();
  memoCache.delete(key); // re-insert so Map order tracks recency
  memoCache.set(key, { at: now, value });
  while (memoCache.size > 100) memoCache.delete(memoCache.keys().next().value);
  return value;
}

// Heavy read paths (analytics-style scans) are keyed to the hour and kept
// just past an hour, so the hourly background warm-up (scheduledJobs.js)
// keeps them permanently fresh: a request always finds the previous
// top-of-hour computation instead of paying for a cold multi-second disk
// scan.
const HOUR_MS = 3600 * 1000;
export const HEAVY_TTL_MS = 75 * 60_000;
export const DAY_ROW_TTL_MS = 7 * 24 * HOUR_MS; // a completed day's figures never change
export const memoKeys = {
  analytics: ({ from, to, channelKinds, channelLabels, timezone }) =>
    `a:${Math.floor(from / HOUR_MS)}:${Math.floor(to / HOUR_MS)}:${timezone}:${channelKinds.join(",")}:${channelLabels.join("|")}`,
  hourly: ({ from, to, channelKinds, timezone }) =>
    `hc:${Math.floor(from / HOUR_MS)}:${Math.floor(to / HOUR_MS)}:${timezone}:${channelKinds.join(",")}`,
  dailyRow: (date, channelKinds, timezone) => `dc:${date}:${timezone}:${channelKinds.join(",")}`,
};

// ── Per-minute aggregate (readings_1m) ──────────────────────────────────
const MINUTE = 60_000;
const floorMinute = (ts) => Math.floor(ts / MINUTE) * MINUTE;
const ceilMinute = (ts) => Math.ceil(ts / MINUTE) * MINUTE;
const aggUpsertStmt = db.prepare(
  "INSERT INTO readings_1m (ts, n, tp, p) VALUES (?, ?, ?, ?) ON CONFLICT(ts) DO UPDATE SET n = excluded.n, tp = excluded.tp, p = excluded.p"
);
const aggRangeStmt = db.prepare("SELECT ts, n, tp, p FROM readings_1m WHERE ts >= ? AND ts < ? ORDER BY ts");
const aggBoundsStmt = db.prepare("SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs FROM readings_1m");
const aggRawChunkStmt = db.prepare("SELECT ts, tp, p FROM readings WHERE ts >= ? AND ts < ? ORDER BY ts");

/**
 * (Re)builds readings_1m for every whole minute in [from, to) from the raw
 * readings, one hour of raw rows at a time so memory stays flat no matter
 * how long the range is. Idempotent (upserts). Returns minutes written.
 */
export function aggregateRange(from, to) {
  let written = 0;
  const HOUR = 60 * MINUTE;
  for (let chunk = floorMinute(from); chunk < to; chunk += HOUR) {
    const chunkEnd = Math.min(chunk + HOUR, floorMinute(to));
    if (chunkEnd <= chunk) break;
    const minutes = new Map(); // minuteStart -> { n, tp, p[] }
    for (const row of aggRawChunkStmt.iterate(chunk, chunkEnd)) {
      const m = floorMinute(row.ts);
      const p = JSON.parse(row.p);
      let b = minutes.get(m);
      if (!b) {
        b = { n: 0, tp: 0, p: new Array(p.length).fill(0) };
        minutes.set(m, b);
      }
      b.n += 1;
      b.tp += row.tp;
      for (let i = 0; i < p.length; i++) b.p[i] += p[i] ?? 0;
    }
    if (minutes.size === 0) continue;
    db.exec("BEGIN");
    try {
      for (const [m, b] of minutes) {
        aggUpsertStmt.run(m, b.n, b.tp / b.n, JSON.stringify(b.p.map((x) => x / b.n)));
        written++;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return written;
}

/**
 * Startup catch-up: aggregate any completed minutes since the last one
 * already in readings_1m. Deliberately a no-op while the table is empty —
 * the full-history backfill is scripts/backfill-minute-agg.js, run once,
 * not something to block server startup on.
 */
function catchUpMinuteAgg() {
  const { maxTs } = aggBoundsStmt.get();
  if (maxTs == null) return;
  aggregateRange(maxTs + MINUTE, Date.now());
}

let lastAggMinute = null;

/**
 * Whether readings_1m fully covers [from, to) closely enough to answer from
 * it instead of raw rows — same tolerance queryHistoryFromAgg() already
 * uses: the aggregate must reach back to `from`, and its tail gap up to
 * `to` (new minutes not rolled up yet — addReading()'s incremental rollup
 * normally keeps this under a minute) must be under 30 minutes, else it's
 * not worth risking a stale answer and the raw path runs instead.
 */
function aggCoverage(from, to) {
  const { minTs, maxTs } = aggBoundsStmt.get();
  if (minTs == null) return null;
  const aggFrom = ceilMinute(from);
  if (aggFrom < minTs) return null;
  const tailFrom = Math.min(floorMinute(to), maxTs + MINUTE);
  if (to - tailFrom > 30 * MINUTE) return null;
  return { aggFrom, tailFrom };
}
const rangeStmt = db.prepare("SELECT ts, tp, p, eIn, eOut FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts");
const rangeLightStmt = db.prepare("SELECT ts, tp, p FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts");
const dayRangeStmt = db.prepare("SELECT ts, tp, p FROM readings WHERE ts >= ? AND ts < ? ORDER BY ts");
const minMaxTsStmt = db.prepare("SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs FROM readings");
const upsertDailyStmt = db.prepare(`
  INSERT INTO daily_stats (date, weekday, sampleCount, avgGridPower, avgHouseholdPower, importKwh, exportKwh, netKwh)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(date) DO UPDATE SET
    weekday=excluded.weekday, sampleCount=excluded.sampleCount, avgGridPower=excluded.avgGridPower,
    avgHouseholdPower=excluded.avgHouseholdPower, importKwh=excluded.importKwh, exportKwh=excluded.exportKwh,
    netKwh=excluded.netKwh
`);
const dailyRangeStmt = db.prepare("SELECT * FROM daily_stats WHERE date >= ? AND date <= ? ORDER BY date");
const dailyHasStmt = db.prepare("SELECT 1 FROM daily_stats WHERE date = ?");

const upsertDailySnapshotStmt = db.prepare(`
  INSERT INTO daily_snapshots (
    date, sampleCount, producedKwh, gridImportKwh, gridExportKwh, totalKwh,
    biggestCircuitIndex, biggestCircuitLabel, biggestCircuitKwh,
    peakTs, peakTotalPower, peakGridPower, peakSolarPower,
    peakProductionTs, peakProductionW
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(date) DO UPDATE SET
    sampleCount=excluded.sampleCount, producedKwh=excluded.producedKwh, gridImportKwh=excluded.gridImportKwh,
    gridExportKwh=excluded.gridExportKwh,
    totalKwh=excluded.totalKwh, biggestCircuitIndex=excluded.biggestCircuitIndex,
    biggestCircuitLabel=excluded.biggestCircuitLabel, biggestCircuitKwh=excluded.biggestCircuitKwh,
    peakTs=excluded.peakTs, peakTotalPower=excluded.peakTotalPower, peakGridPower=excluded.peakGridPower,
    peakSolarPower=excluded.peakSolarPower, peakProductionTs=excluded.peakProductionTs,
    peakProductionW=excluded.peakProductionW
`);
const dailySnapshotGetStmt = db.prepare("SELECT * FROM daily_snapshots WHERE date = ?");

/** DB row -> the same shape computeSnapshotFromRows() + { date } returns. */
function rowToDailySnapshot(row) {
  return {
    date: row.date,
    sampleCount: row.sampleCount,
    producedKwh: row.producedKwh,
    gridImportKwh: row.gridImportKwh,
    gridExportKwh: row.gridExportKwh,
    totalKwh: row.totalKwh,
    biggestCircuit:
      row.biggestCircuitIndex == null
        ? null
        : { index: row.biggestCircuitIndex, label: row.biggestCircuitLabel, kwh: row.biggestCircuitKwh },
    peak:
      row.peakTs == null
        ? null
        : { ts: row.peakTs, totalPower: row.peakTotalPower, gridPower: row.peakGridPower, solarPower: row.peakSolarPower },
    peakProduction: row.peakProductionTs == null ? null : { ts: row.peakProductionTs, solarPower: row.peakProductionW },
  };
}

function cacheDailySnapshot(ds, snap) {
  upsertDailySnapshotStmt.run(
    ds,
    snap.sampleCount,
    snap.producedKwh,
    snap.gridImportKwh,
    snap.gridExportKwh ?? 0,
    snap.totalKwh,
    snap.biggestCircuit?.index ?? null,
    snap.biggestCircuit?.label ?? null,
    snap.biggestCircuit?.kwh ?? null,
    snap.peak?.ts ?? null,
    snap.peak?.totalPower ?? null,
    snap.peak?.gridPower ?? null,
    snap.peak?.solarPower ?? null,
    snap.peakProduction?.ts ?? null,
    snap.peakProduction?.solarPower ?? null
  );
}

let lastReadingDateStr = null;

function parseRow(row) {
  return { ts: row.ts, tp: row.tp, p: JSON.parse(row.p), eIn: JSON.parse(row.eIn), eOut: JSON.parse(row.eOut) };
}

function parseRowLight(row) {
  return { ts: row.ts, tp: row.tp, p: JSON.parse(row.p) };
}

function fetchRange(from, to) {
  return rangeStmt.all(from, to).map(parseRow);
}

/**
 * Same as fetchRange(), minus the `eIn`/`eOut` cumulative-energy columns —
 * every power/kWh-integration read path (hourly/daily consumption,
 * analytics, snapshots, charting) only ever touches `ts`/`tp`/`p`, so
 * fetching and JSON-parsing two extra per-channel arrays per row for those
 * paths was pure waste. Only querySummary() needs the real eIn/eOut deltas
 * (energy counter readings), so it's the one caller left on fetchRange().
 */
function fetchRangeLight(from, to) {
  return rangeLightStmt.all(from, to).map(parseRowLight);
}

/** [from, to) for the local calendar day `dateStrVal` ("YYYY-MM-DD"), as reckoned in `timezone` — the +25h-then-floor step (not a flat +24h) keeps this correct across a DST transition, same trick dailySnapshots() and others in this file already use. */
function dayBounds(dateStrVal, timezone) {
  const from = localDateToUtcMs(dateStrVal, timezone);
  return { from, to: dayStartUtcMs(from + 25 * 3600 * 1000, timezone) };
}

/**
 * Open (or create) the SQLite store and catch up any completed calendar
 * days that don't have a daily_stats rollup yet (e.g. the server was down
 * across midnight). Returns the total number of raw readings on disk.
 */
export function initStore(channelKinds, timezone) {
  rollupMissingDays(channelKinds, timezone);
  catchUpMinuteAgg();
  const { minTs, maxTs } = minMaxTsStmt.get();
  if (minTs != null) lastReadingDateStr = localDateStr(maxTs, timezone);
  return db.prepare("SELECT COUNT(*) AS n FROM readings").get().n;
}

export function addReading(reading, channelKinds, timezone) {
  insertReadingStmt.run(
    reading.ts,
    reading.totalPower,
    JSON.stringify(reading.channels.map((c) => c.power)),
    JSON.stringify(reading.channels.map((c) => c.energyIn)),
    JSON.stringify(reading.channels.map((c) => c.energyOut))
  );

  const minute = floorMinute(reading.ts);
  if (lastAggMinute !== null && minute > lastAggMinute) aggregateRange(lastAggMinute, minute); // the minute(s) that just ended
  lastAggMinute = minute;

  const today = localDateStr(reading.ts, timezone);
  if (lastReadingDateStr && today !== lastReadingDateStr) {
    rollupDay(lastReadingDateStr, channelKinds, timezone); // the day that just ended
  }
  lastReadingDateStr = today;
}

function householdLoadOf(row, channelKinds) {
  let h = 0;
  for (let i = 0; i < CIRCUIT_COUNT; i++) if (channelKinds[i] !== "producer") h += row.p[i] ?? 0;
  return h;
}

/**
 * Average grid power, solar power, and total consumption per calendar hour
 * in [from, to] — used to correlate against outdoor temperature. Total
 * consumption is `solar produced + grid imported` (the real household
 * energy balance, via the main-phase measurement), not a sum of whichever
 * breaker circuits happen to be tagged "consumer" — that undercounts if any
 * load isn't on a monitored circuit.
 */
export function hourlyConsumption(args) {
  return memo(memoKeys.hourly(args), HEAVY_TTL_MS, () => hourlyConsumptionUncached(args));
}

function hourlyConsumptionUncached({ from, to, channelKinds, timezone }) {
  const producerIdx = [];
  for (let i = 0; i < CIRCUIT_COUNT; i++) if (channelKinds[i] === "producer") producerIdx.push(i);

  // Averaging a weighted-by-sample-count per-minute mean gives the exact
  // same per-hour average as averaging every raw 2-second sample directly
  // (a weighted mean of means, weighted by how many raw samples each mean
  // represents, equals the overall mean) — so the aggregate path here isn't
  // an approximation, just a ~60x-fewer-rows way to compute the identical
  // number. See computeAnalytics()'s doc comment for the one place in this
  // file where the two paths *aren't* numerically identical.
  const coverage = aggCoverage(from, to);
  const buckets = new Map(); // hourStartTs -> { sumGrid, sumSolar, count }
  const addSample = (ts, tp, p, weight) => {
    // The bucket key is a real instant (the start of the local hour
    // containing `ts`, in `timezone`) — not a bare 0-23 label — so the
    // frontend formatting it via the viewer's own clock shows the right
    // hour regardless of what timezone the server itself runs in.
    const hourTs = localHourStartUtcMs(ts, timezone);
    let b = buckets.get(hourTs);
    if (!b) {
      b = { sumGrid: 0, sumSolar: 0, count: 0 };
      buckets.set(hourTs, b);
    }
    b.sumGrid += tp * weight;
    b.sumSolar += producerIdx.reduce((s, i) => s + (p[i] ?? 0), 0) * weight;
    b.count += weight;
  };

  if (coverage) {
    for (const row of aggRangeStmt.iterate(coverage.aggFrom, coverage.tailFrom)) {
      addSample(row.ts, row.tp, JSON.parse(row.p), row.n);
    }
    for (const rec of fetchRangeLight(coverage.tailFrom, to)) addSample(rec.ts, rec.tp, rec.p, 1);
  } else {
    for (const rec of fetchRangeLight(from, to)) addSample(rec.ts, rec.tp, rec.p, 1);
  }

  return [...buckets.entries()].map(([ts, b]) => {
    const gridPower = round2(b.sumGrid / b.count);
    const solarPower = round2(b.sumSolar / b.count);
    return { ts, gridPower, solarPower, totalPower: round2(gridPower + solarPower) };
  });
}

function totalConsumptionOf(tp, p, producerIdx) {
  const solar = producerIdx.reduce((s, i) => s + (p[i] ?? 0), 0);
  return Math.max(0, tp) + solar; // same identity as hourlyConsumption/dailyConsumption
}

/**
 * Average total consumption (solar + grid import) across every occurrence
 * of local hour-of-day `hour` in [from, to) — the "usual for this time of
 * day" usage alerts compare against. Used to filter via SQLite's own
 * `strftime(..., 'localtime')`, which resolves to *this VM's OS timezone*
 * (UTC) — silently wrong for any zip code that isn't also UTC, which is
 * always, since this VM deliberately runs UTC (see tz.js). Reads from
 * readings_1m when it covers the range (BASELINE_DAYS is weeks wide, so
 * this matters: readings_1m is ~60x fewer rows to filter through in JS
 * than raw rows would be) and filters by the *zip's* local hour via
 * localHour(), falling back to raw rows the same way the rest of this file
 * does when the aggregate doesn't (yet) cover the range. Returns
 * { avg: null, sampleCount: 0 } if there's no data yet for that hour.
 */
export function hourlyBaselineConsumption({ from, to, hour, channelKinds, timezone }) {
  const producerIdx = [];
  for (let i = 0; i < CIRCUIT_COUNT; i++) if (channelKinds[i] === "producer") producerIdx.push(i);
  let sum = 0;
  let weight = 0;
  const addSample = (ts, tp, p, w) => {
    if (localHour(ts, timezone) !== hour) return;
    sum += totalConsumptionOf(tp, p, producerIdx) * w;
    weight += w;
  };

  const coverage = aggCoverage(from, to);
  if (coverage) {
    for (const row of aggRangeStmt.iterate(coverage.aggFrom, coverage.tailFrom)) addSample(row.ts, row.tp, JSON.parse(row.p), row.n);
    for (const rec of fetchRangeLight(coverage.tailFrom, to)) addSample(rec.ts, rec.tp, rec.p, 1);
  } else {
    for (const rec of fetchRangeLight(from, to)) addSample(rec.ts, rec.tp, rec.p, 1);
  }

  if (weight === 0) return { avg: null, sampleCount: 0 };
  return { avg: round2(sum / weight), sampleCount: weight };
}

/**
 * Average total consumption (solar + grid import) over the last `minutes`
 * — the "right now" side of a usage-alert comparison, smoothed over a short
 * window so one noisy sample can't trigger a false alarm.
 */
export function recentAverageConsumption({ minutes, channelKinds }) {
  const rows = fetchRangeLight(Date.now() - minutes * 60_000, Date.now());
  if (rows.length === 0) return { avg: null, sampleCount: 0 };
  const producerIdx = [];
  for (let i = 0; i < CIRCUIT_COUNT; i++) if (channelKinds[i] === "producer") producerIdx.push(i);
  let sum = 0;
  for (const row of rows) sum += totalConsumptionOf(row.tp, row.p, producerIdx);
  return { avg: round2(sum / rows.length), sampleCount: rows.length };
}

/**
 * Total energy consumed per calendar day in [from, to] — same
 * `solar produced + grid imported` identity as hourlyConsumption, but
 * integrated (trapezoidal, kWh) over each whole day rather than averaged
 * per hour. Scans raw readings directly (like hourlyConsumption) rather
 * than the daily_stats rollup, since that table doesn't track solar
 * separately.
 *
 * Queried one local day at a time — same reason and same pattern as
 * dailySnapshots() below: `/api/weather-daily` always asks for the last 90
 * days on every single Analytics page load (not bounded by the range
 * picker), so this is the one query in the app guaranteed to keep growing
 * every day the meter keeps running. One `fetchRangeLight` over the whole
 * range would eventually repeat the exact OOM dailySnapshots() hit before
 * it was rewritten the same way. Day boundaries are in `timezone` (the
 * zip's own timezone, via tz.js) — not the server's local time, which on
 * the production VM (UTC) previously put day boundaries at 4pm Pacific
 * instead of midnight.
 */
export function dailyConsumption({ from, to, channelKinds, timezone }) {
  const producerIdx = [];
  for (let i = 0; i < CIRCUIT_COUNT; i++) if (channelKinds[i] === "producer") producerIdx.push(i);

  const results = [];
  const todayStr = localDateStr(Date.now(), timezone);
  let dayStart = dayStartUtcMs(from, timezone);
  while (dayStart < to) {
    // Jump 25h (not 24h) before re-snapping, so a DST spring-forward day
    // (23h wall-clock) still lands on the next local day rather than
    // re-processing the same one — same trick dailySnapshots() uses.
    const nextDayStart = dayStartUtcMs(dayStart + 25 * 3600 * 1000, timezone);
    const rangeEnd = Math.min(nextDayStart, to);
    const ds = localDateStr(dayStart, timezone);
    const computeDay = () => {
      const rows = fetchRangeLight(dayStart, rangeEnd);
      if (rows.length < 2) return null;
      const gridImportKwh = integrateKwh(rows, (r) => Math.max(0, r.tp));
      const gridExportKwh = integrateKwh(rows, (r) => Math.max(0, -r.tp));
      const solarKwh = integrateKwh(rows, (r) => producerIdx.reduce((s, i) => s + (r.p[i] ?? 0), 0));
      return {
        date: ds,
        totalKwh: round4(gridImportKwh + solarKwh),
        gridImportKwh: round4(gridImportKwh),
        gridExportKwh: round4(gridExportKwh),
        solarKwh: round4(solarKwh),
        sampleCount: rows.length,
      };
    };
    // A finished, whole day's figures never change again, so each is
    // computed once and kept — a 90-day request is then ~1 day of scanning
    // (today), not 90. Today and any range-truncated day stay uncached.
    const cacheable = ds < todayStr && rangeEnd === nextDayStart;
    const row = cacheable ? memo(memoKeys.dailyRow(ds, channelKinds, timezone), DAY_ROW_TTL_MS, computeDay) : computeDay();
    if (row) results.push(row);
    dayStart = nextDayStart;
  }
  return results;
}

/**
 * "Today" snapshot for the top of the Live tab: totals so far today (solar
 * produced, grid imported, total = the same identity as everywhere else),
 * the single biggest-consuming circuit today, and the moment of peak total
 * consumption today. "Today" starts at 00:00 in `timezone` — the zip's own
 * timezone, not this server's (which may well be a different one, e.g. this
 * VM runs UTC) — see tz.js.
 *
 * `sunWindow` ({sunriseTs, sunsetTs} for today, or null if unknown) guards
 * against a real hardware quirk: producer-tagged channels are CT clamps on
 * the solar inverter's own circuit, and after dark the inverter still draws
 * a few watts of its own (staying powered, syncing status to the solar
 * company's cloud) — through the *same* clamp, read as a normal positive
 * wattage with no way to tell "producing" from "drawing" from the number
 * alone. Left uncorrected this double-counts: that draw already shows up
 * as grid import (it has to come from somewhere), and counting it *again*
 * as production inflates total consumption by 2x the draw. So outside
 * [sunrise, sunset), producer channels contribute 0 here rather than their
 * raw reading — this is a heuristic (a very cloudy midday could read as
 * near-zero production and get miscounted the other way), but a solid one:
 * real production during full darkness isn't physically possible, so this
 * can only ever correct a false positive, never remove a real one.
 *
 * One combined pass over today's raw rows (not one integrateKwh() call per
 * circuit) — this runs on a polling interval from the frontend, so it's
 * worth keeping O(rows) rather than O(16 × rows).
 */
export function todaySnapshot({ channelKinds, channelLabels, timezone, sunWindow }) {
  const now = Date.now();
  const dayStart = dayStartUtcMs(now, timezone);
  return { dayStart, ...getLiveSnapshot(dayStart, now, channelKinds, channelLabels, sunWindow) };
}

// The still-in-progress day's snapshot — a full scan of up to ~43k raw rows
// — is recomputed on a schedule (scheduledJobs.js, every 15 min, off the
// request path entirely) rather than on demand: /api/today-snapshot and the
// current day's row in /api/daily-snapshots both just read this cache, so
// neither one ever triggers a live raw-row scan of its own. The one
// exception is a cold cache (right after a restart, or the first request of
// a new calendar day before the next scheduled tick) — that still computes
// once, synchronously, so the page never shows nothing.
let liveSnapshotCache = null; // { dayStart, snapshot }

/** Recomputes today's snapshot right now and stores it as the cache scheduledJobs.js's timer calls this; store.js itself never calls it on a request path. */
export function refreshLiveSnapshot({ channelKinds, channelLabels, timezone, sunWindow }) {
  const dayStart = dayStartUtcMs(Date.now(), timezone);
  const snapshot = computeSnapshotFromRows(fetchRangeLight(dayStart, Date.now()), channelKinds, channelLabels, sunWindow);
  liveSnapshotCache = { dayStart, snapshot };
  return snapshot;
}

function getLiveSnapshot(dayStart, upTo, channelKinds, channelLabels, sunWindow) {
  if (liveSnapshotCache && liveSnapshotCache.dayStart === dayStart) return liveSnapshotCache.snapshot;
  // Cold cache — compute once now (rare: startup, or the moment a new local
  // day starts) rather than serve nothing until the next scheduled refresh.
  return computeSnapshotFromRows(fetchRangeLight(dayStart, upTo), channelKinds, channelLabels, sunWindow);
}

/**
 * Shared core for todaySnapshot() (and daySnapshot()/monthSnapshots() below):
 * totals over `rows` (solar produced, grid imported, total = the same
 * identity as everywhere else — see the sunWindow note in todaySnapshot's
 * doc comment above), the single biggest-consuming circuit, and the moment
 * of peak total consumption.
 *
 * Peak-finding rejects lone-sample spikes: a single reading far higher than
 * *both* immediate neighbors, with no gradual ramp. Confirmed against real
 * data — this meter occasionally reports a main-phase value 20-30x too high
 * for exactly one ~2s sample while every circuit channel stays completely
 * unchanged (a corrupted MQTT payload, not a real load — a real one, like
 * an AC compressor kicking in, ramps over at least a couple of consecutive
 * samples and shows up in the circuit breakdown too). This only affects
 * which single instant gets reported as "the peak" — kWh totals are already
 * naturally robust to one bad 2-second sample, since trapezoidal
 * integration weights by duration, not by how extreme a single point is.
 */
function computeSnapshotFromRows(rows, channelKinds, channelLabels, sunWindow) {
  if (rows.length === 0) {
    return {
      sampleCount: 0,
      producedKwh: 0,
      gridImportKwh: 0,
      gridExportKwh: 0,
      totalKwh: 0,
      biggestCircuit: null,
      peak: null,
      peakProduction: null,
    };
  }

  const producerIdx = [];
  for (let i = 0; i < CIRCUIT_COUNT; i++) if (channelKinds[i] === "producer") producerIdx.push(i);
  const isDaytime = (ts) => isWithinDaylight(ts, sunWindow) ?? true;
  const solarOf = (r) => (isDaytime(r.ts) ? producerIdx.reduce((s, i) => s + (r.p[i] ?? 0), 0) : 0);

  // Precomputed once, reused by both the integration pass and peak-finding below.
  const n = rows.length;
  const solarArr = new Array(n);
  const gridArr = new Array(n);
  const totalArr = new Array(n);
  for (let i = 0; i < n; i++) {
    solarArr[i] = solarOf(rows[i]);
    gridArr[i] = Math.max(0, rows[i].tp);
    totalArr[i] = solarArr[i] + gridArr[i];
  }

  const circuitKwh = new Array(CIRCUIT_COUNT).fill(0);
  let producedKwh = 0;
  let gridImportKwh = 0;
  let gridExportKwh = 0;

  for (let idx = 1; idx < n; idx++) {
    const dtHours = (rows[idx].ts - rows[idx - 1].ts) / 3_600_000;
    if (dtHours <= 0 || dtHours > 1) continue;
    // Trapezoidal avg-W * hours = Wh — divide by 1000 for kWh, same as integrateKwh().
    producedKwh += (((solarArr[idx - 1] + solarArr[idx]) / 2) * dtHours) / 1000;
    gridImportKwh += (((gridArr[idx - 1] + gridArr[idx]) / 2) * dtHours) / 1000;
    // Export doesn't need the day/night solar filter that gridArr/solarArr
    // get — it's a direct mains reading, not a producer-clamp reading, so
    // the inverter-standby-draw ambiguity that motivates that filter
    // doesn't apply here.
    const exp0 = Math.max(0, -rows[idx - 1].tp);
    const exp1 = Math.max(0, -rows[idx].tp);
    gridExportKwh += (((exp0 + exp1) / 2) * dtHours) / 1000;
    for (let i = 0; i < CIRCUIT_COUNT; i++) {
      if (channelKinds[i] === "producer") continue;
      circuitKwh[i] += ((((rows[idx - 1].p[i] ?? 0) + (rows[idx].p[i] ?? 0)) / 2) * dtHours) / 1000;
    }
  }

  let peak = { total: -Infinity, ts: null, gridPower: 0, solarPower: 0 };
  let peakProduction = { solar: -Infinity, ts: null };
  for (let i = 0; i < n; i++) {
    const prevTotal = i > 0 ? totalArr[i - 1] : totalArr[i];
    const nextTotal = i < n - 1 ? totalArr[i + 1] : totalArr[i];
    const neighborCeiling = Math.max(prevTotal, nextTotal, 500) * 3; // floor of 500W so quiet neighbors don't flag everything
    if (totalArr[i] <= neighborCeiling && totalArr[i] > peak.total) {
      peak = { total: totalArr[i], ts: rows[i].ts, gridPower: round2(gridArr[i]), solarPower: round2(solarArr[i]) };
    }

    // Same lone-spike rejection, applied to solar output specifically — a
    // glitched sample on a producer channel would otherwise report an
    // impossible instantaneous "peak production" the same way it can on
    // the grid total above.
    const prevSolar = i > 0 ? solarArr[i - 1] : solarArr[i];
    const nextSolar = i < n - 1 ? solarArr[i + 1] : solarArr[i];
    const solarNeighborCeiling = Math.max(prevSolar, nextSolar, 200) * 3;
    if (solarArr[i] <= solarNeighborCeiling && solarArr[i] > peakProduction.solar) {
      peakProduction = { solar: solarArr[i], ts: rows[i].ts };
    }
  }

  let biggestCircuit = null;
  let bestKwh = -Infinity;
  for (let i = 0; i < CIRCUIT_COUNT; i++) {
    if (channelKinds[i] === "producer") continue;
    if (circuitKwh[i] > bestKwh) {
      bestKwh = circuitKwh[i];
      biggestCircuit = { index: i, label: channelLabels[i] ?? `Circuit ${i + 1}`, kwh: round4(circuitKwh[i]) };
    }
  }

  return {
    sampleCount: n,
    producedKwh: round4(producedKwh),
    gridImportKwh: round4(gridImportKwh),
    gridExportKwh: round4(gridExportKwh),
    totalKwh: round4(producedKwh + gridImportKwh),
    biggestCircuit,
    peak: peak.ts ? { ts: peak.ts, totalPower: round2(peak.total), gridPower: peak.gridPower, solarPower: peak.solarPower } : null,
    peakProduction: peakProduction.ts ? { ts: peakProduction.ts, solarPower: round2(peakProduction.solar) } : null,
  };
}

/**
 * Same fields as todaySnapshot(), for every local calendar day that has
 * data in [from, to] — the Daily Snapshots history page (month calendar +
 * per-day detail) is built on this.
 *
 * Queried one local day at a time, NOT via one fetchRange() over the whole
 * range — a full month at this meter's ~2s sample cadence is over a
 * million raw rows, more than enough to OOM a small VM if held in memory
 * all at once (confirmed the hard way: this originally loaded the whole
 * range up front and got the process OOM-killed on a real month view).
 * Querying day-by-day keeps peak memory bounded to one day's rows
 * (≈43k max) regardless of how many days the requested range spans.
 *
 * Completed days (anything before today, zip-local) are cached in
 * daily_snapshots — see the table's own comment — so this only ever scans
 * raw rows once per day, total, no matter how many times that day gets
 * viewed afterward. Normally that cache is already warm by the time anyone
 * looks: index.js rolls a day up right after it ends (see
 * maybeRollupYesterday there). This is the fallback/catch-up path — first
 * page load ever, a gap from the server being down across midnight, or any
 * day that predates this cache existing — computed once here and written
 * through so every later view of that same day is the cheap lookup instead.
 * Today itself is never cached (it's still changing), always computed live.
 */
export function dailySnapshots({ from, to, channelKinds, channelLabels, timezone, sunWindows }) {
  const results = [];
  const todayStr = localDateStr(Date.now(), timezone);
  let dayStart = dayStartUtcMs(from, timezone);
  while (dayStart < to) {
    // +25h then floor to that day's start: lands in the next local day even
    // across a 23h DST "spring forward" day, then snaps to its exact 00:00.
    const nextDayStart = dayStartUtcMs(dayStart + 25 * 3600 * 1000, timezone);
    const rangeEnd = Math.min(nextDayStart, to);
    const ds = localDateStr(dayStart, timezone);
    const isCompletedDay = ds < todayStr;

    if (isCompletedDay) {
      const cached = dailySnapshotGetStmt.get(ds);
      if (cached) {
        results.push(rowToDailySnapshot(cached));
        dayStart = nextDayStart;
        continue;
      }
    }

    const sunWindow = sunWindows?.get(ds) ?? null;
    if (!isCompletedDay) {
      const snap = getLiveSnapshot(dayStart, rangeEnd, channelKinds, channelLabels, sunWindow);
      if (snap.sampleCount > 0) results.push({ date: ds, ...snap });
    } else {
      const rows = fetchRangeLight(dayStart, rangeEnd);
      if (rows.length > 0) {
        const snap = computeSnapshotFromRows(rows, channelKinds, channelLabels, sunWindow);
        results.push({ date: ds, ...snap });
        cacheDailySnapshot(ds, snap);
      }
    }
    dayStart = nextDayStart;
  }
  return results;
}

/**
 * Proactively compute and cache one completed day's snapshot — called from
 * index.js right after that local day ends (see maybeRollupYesterday), so
 * the cache in dailySnapshots() above is already warm on the very first
 * view rather than only from the second view onward. Safe to call again
 * for the same day (e.g. a late-arriving reading after the first rollup,
 * or a retry) — upserts, doesn't duplicate. No-ops if there's no data for
 * that day yet.
 */
export function persistDailySnapshotIfComplete(ds, { channelKinds, channelLabels, timezone, sunWindow }) {
  const dayStart = localDateToUtcMs(ds, timezone);
  const dayEnd = dayStartUtcMs(dayStart + 25 * 3600 * 1000, timezone);
  const rows = fetchRangeLight(dayStart, dayEnd);
  if (rows.length === 0) return null;
  const snap = computeSnapshotFromRows(rows, channelKinds, channelLabels, sunWindow);
  cacheDailySnapshot(ds, snap);
  return { date: ds, ...snap }; // handed back so callers (e.g. the daily email) can reuse it without recomputing
}

function rollupDay(dateStrVal, channelKinds, timezone) {
  const { from, to } = dayBounds(dateStrVal, timezone);
  const rows = dayRangeStmt.all(from, to);
  if (rows.length === 0) return;
  const parsed = rows.map((r) => ({ ts: r.ts, tp: r.tp, p: JSON.parse(r.p) }));

  let sumGrid = 0,
    sumHousehold = 0;
  for (const r of parsed) {
    sumGrid += r.tp;
    sumHousehold += householdLoadOf(r, channelKinds);
  }
  const importKwh = integrateKwh(parsed, (r) => Math.max(0, r.tp));
  const exportKwh = integrateKwh(parsed, (r) => Math.max(0, -r.tp));
  const weekday = localWeekday(from, timezone);

  upsertDailyStmt.run(
    dateStrVal,
    weekday,
    parsed.length,
    round2(sumGrid / parsed.length),
    round2(sumHousehold / parsed.length),
    round4(importKwh),
    round4(exportKwh),
    round4(importKwh - exportKwh)
  );
}

/** Roll up any completed (non-today) calendar day that has raw data but no daily_stats row yet. */
function rollupMissingDays(channelKinds, timezone) {
  const { minTs, maxTs } = minMaxTsStmt.get();
  if (minTs == null) return;
  const todayStr = localDateStr(Date.now(), timezone);
  let cursor = dayBounds(localDateStr(minTs, timezone), timezone).from;
  const lastCompleteBound = Math.min(maxTs, dayBounds(todayStr, timezone).from - 1);
  while (cursor <= lastCompleteBound) {
    const ds = localDateStr(cursor, timezone);
    if (ds !== todayStr && !dailyHasStmt.get(ds)) rollupDay(ds, channelKinds, timezone);
    cursor = dayBounds(ds, timezone).to;
  }
}

/**
 * Bucketed history for charting: averages power per channel (and total)
 * into ~`points` buckets across [from, to].
 */
export function queryHistory({ from, to, points = 300 }) {
  const span = Math.max(1, to - from);
  const bucketMs = Math.max(1000, Math.round(span / points));
  // Same (bucket-aligned) window asked for again within a bucket's width —
  // several cards / tabs / the poll timer — reuses one computation.
  const key = `h:${Math.floor(from / bucketMs)}:${Math.floor(to / bucketMs)}:${points}`;
  return memo(key, Math.min(30_000, Math.max(2_000, bucketMs)), () => {
    const viaAgg = bucketMs >= MINUTE ? queryHistoryFromAgg(from, to, bucketMs) : null;
    return viaAgg ?? queryHistoryFromRaw(from, to, bucketMs);
  });
}

function bucketsToPoints(buckets) {
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, b]) => ({
      ts,
      totalPower: round2(b.sumTotal / b.count),
      channels: b.sumP.map((s) => round2(s / b.count)),
    }));
}

function addToBucket(buckets, bucketStart, weight, tp, p) {
  let b = buckets.get(bucketStart);
  if (!b) {
    b = { sumP: new Array(p.length).fill(0), count: 0, sumTotal: 0 };
    buckets.set(bucketStart, b);
  }
  for (let i = 0; i < p.length; i++) b.sumP[i] += (p[i] ?? 0) * weight;
  b.sumTotal += tp * weight;
  b.count += weight;
}

function queryHistoryFromRaw(from, to, bucketMs) {
  const buckets = new Map();
  for (const row of rangeLightStmt.iterate(from, to)) {
    addToBucket(buckets, from + Math.floor((row.ts - from) / bucketMs) * bucketMs, 1, row.tp, JSON.parse(row.p));
  }
  return bucketsToPoints(buckets);
}

/**
 * Same result as queryHistoryFromRaw() for buckets of a minute or more, but
 * read from the per-minute averages (weighted by sample count, so the
 * re-average is exact) plus the still-unaggregated tail from raw rows.
 * ~1,440 rows per day instead of ~43,000, and no per-row JSON of 16
 * channels for the raw ones. Returns null — caller falls back to raw — when
 * readings_1m doesn't (yet) cover the whole requested window.
 */
function queryHistoryFromAgg(from, to, bucketMs) {
  const { minTs, maxTs } = aggBoundsStmt.get();
  if (minTs == null) return null;
  const aggFrom = ceilMinute(from);
  if (aggFrom < minTs) return null; // not backfilled that far back
  const tailFrom = Math.min(floorMinute(to), maxTs + MINUTE);
  if (to - tailFrom > 30 * MINUTE) return null; // aggregate is stale — don't scan a big raw tail
  const buckets = new Map();
  for (const row of aggRangeStmt.iterate(aggFrom, tailFrom)) {
    const mid = row.ts + MINUTE / 2;
    addToBucket(buckets, from + Math.floor((mid - from) / bucketMs) * bucketMs, row.n, row.tp, JSON.parse(row.p));
  }
  for (const row of rangeLightStmt.iterate(Math.max(tailFrom, from), to)) {
    addToBucket(buckets, from + Math.floor((row.ts - from) / bucketMs) * bucketMs, 1, row.tp, JSON.parse(row.p));
  }
  return bucketsToPoints(buckets);
}

/**
 * Exact (non-bucketed) summary stats for a range. Pass `channel` (a channel
 * index) to scope power + energy stats to a single circuit instead of the
 * whole-household grid total.
 */
export function querySummary({ from, to, channel }) {
  const inRange = fetchRange(from, to);
  if (inRange.length === 0) {
    return { from, to, sampleCount: 0, avgPower: 0, maxPower: 0, minPower: 0, energyInKwh: 0, energyOutKwh: 0 };
  }

  const single = Number.isInteger(channel);
  let sum = 0,
    max = -Infinity,
    min = Infinity;
  for (const rec of inRange) {
    const p = single ? rec.p[channel] ?? 0 : rec.tp;
    sum += p;
    if (p > max) max = p;
    if (p < min) min = p;
  }
  const first = inRange[0];
  const last = inRange[inRange.length - 1];
  const energyInKwh = single
    ? round4((last.eIn[channel] ?? 0) - (first.eIn[channel] ?? 0))
    : round4(sumMains(last.eIn) - sumMains(first.eIn));
  const energyOutKwh = single
    ? round4((last.eOut[channel] ?? 0) - (first.eOut[channel] ?? 0))
    : round4(sumMains(last.eOut) - sumMains(first.eOut));

  return {
    from,
    to,
    sampleCount: inRange.length,
    avgPower: round2(sum / inRange.length),
    maxPower: round2(max),
    minPower: round2(min),
    energyInKwh,
    energyOutKwh,
  };
}

export function earliestTimestamp() {
  const { minTs } = minMaxTsStmt.get();
  return minTs ?? null;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Rich aggregate analytics over [from, to]: usage by circuit, typical
 * daily/weekly patterns, grid import/export balance, and a handful of
 * "notable metrics" (peak demand, standby load, most-cycling circuits,
 * self-consumption). `channelKinds`/`channelLabels` are the *current*
 * config (from channelConfig.js) applied to historical samples — same
 * convention as queryHistory/querySummary.
 *
 * Reads from the readings_1m per-minute aggregate (see aggCoverage()) when
 * it covers the range, falling back to raw readings otherwise (a fresh
 * install before the first backfill, or a tail gap wider than 30 minutes).
 * Averages, kWh totals, and the hour-of-day pattern come out numerically
 * IDENTICAL either way — a sample-count-weighted mean of per-minute means
 * equals the mean of the underlying raw samples, and kWh (trapezoidal
 * integration) is already established elsewhere in this file to be
 * insensitive to this kind of averaging over short intervals.
 *
 * Three things are NOT identical on the aggregate path, because they
 * genuinely depend on 2-second resolution: peak demand / standby load (now
 * the highest/lowest per-*minute* average, not the single most extreme
 * 2-second reading), per-circuit std-dev / min / max (same — now computed
 * across minute-means, which naturally smooths out sub-minute spikes, the
 * same kind of smoothing computeSnapshotFromRows()'s own peak-rejection
 * heuristic already treats as noise rather than a real load), and import/
 * export % (now "was this *minute* net-importing on average," not "was
 * this *sample*" — only matters for the rare minute that's genuinely close
 * to 50/50 import and export). A load that actually matters — an AC
 * compressor, an oven — runs for minutes, not seconds, so it still shows up
 * clearly; what's lost is capturing a genuinely brief (<1 min) spike at its
 * exact instantaneous height. This trade was made deliberately, after two
 * real production outages from scanning raw rows here on every request
 * (see README's "History storage" section) — not silently, which is why
 * it's spelled out at this length.
 *
 * Day-of-week and week trends read the small `daily_stats` rollup table
 * (one row per calendar day, kept forever) regardless of which path above
 * ran, so those stay cheap no matter how much history has piled up — only
 * "today" (not rolled up yet) is folded in from whichever source the main
 * pass used.
 *
 * Energy figures are estimated by trapezoidal integration of power over
 * time (skipping gaps > 1h, e.g. a server restart) rather than read off the
 * device's own cumulative counters, which update too coarsely to be useful
 * over short/medium windows — see README.
 */
export function computeAnalytics(args) {
  // This range used to be a many-second-to-minutes raw-row scan (tens of MB
  // to GB of disk reads) before the aggregate path above existed — it's
  // fast now, but this still reuses one computation for an identical view
  // (same hour-aligned window, same channel config), including sharing the
  // in-flight promise between concurrent requests, rather than pay for it
  // twice.
  const key = memoKeys.analytics(args);
  const result = memo(key, HEAVY_TTL_MS, () => computeAnalyticsUncached(args));
  result.catch(() => memoCache.delete(key)); // never cache a failure
  return result;
}

async function computeAnalyticsUncached(args) {
  const coverage = aggCoverage(args.from, args.to);
  return coverage ? computeAnalyticsFromAgg(args, coverage) : computeAnalyticsFromRaw(args);
}

/**
 * Fast path: one pass over readings_1m (plus any not-yet-aggregated tail
 * from raw rows, via `coverage.tailFrom`) — ~60x fewer rows than the raw
 * path for the same range. See computeAnalytics()'s doc comment for what
 * this does and doesn't compute identically to the raw path.
 */
async function computeAnalyticsFromAgg({ from, to, channelKinds, channelLabels, timezone }, coverage) {
  const producerIdx = [];
  for (let i = 0; i < CIRCUIT_COUNT; i++) if (channelKinds[i] === "producer") producerIdx.push(i);
  const acc = newAnalyticsAccumulator(timezone);

  // readings_1m rows are tiny (one float per channel, already averaged) —
  // a whole multi-day range is cheap enough to iterate in one pass, no
  // day-by-day chunking needed the way the raw path requires.
  for (const row of aggRangeStmt.iterate(coverage.aggFrom, coverage.tailFrom)) {
    accumulateSample(acc, row.ts, row.tp, JSON.parse(row.p), row.n, channelKinds, producerIdx, timezone);
  }
  // The not-yet-aggregated tail (usually under a minute, up to 30 min if
  // the background rollup is briefly behind) still needs raw rows — same
  // weight-1 samples the all-raw path uses.
  for (const rec of fetchRangeLight(coverage.tailFrom, to)) {
    accumulateSample(acc, rec.ts, rec.tp, rec.p, 1, channelKinds, producerIdx, timezone);
  }
  // Yield once before finalizing, consistent with the raw path's own
  // yields — a long-ish range is still thousands of JS-side iterations
  // even at minute resolution.
  await new Promise((resolve) => setImmediate(resolve));

  return finalizeAnalytics(acc, { from, to, channelKinds, channelLabels, timezone });
}

/**
 * Fallback path: scans raw readings directly, exactly as this function
 * always has — used only when readings_1m doesn't (yet) cover the range
 * (a fresh install before the first backfill, or a tail gap wider than
 * aggCoverage()'s 30-minute tolerance).
 */
async function computeAnalyticsFromRaw({ from, to, channelKinds, channelLabels, timezone }) {
  const producerIdx = [];
  for (let i = 0; i < CIRCUIT_COUNT; i++) if (channelKinds[i] === "producer") producerIdx.push(i);
  const acc = newAnalyticsAccumulator(timezone);

  // Fetched (and processed) one ~day-sized chunk at a time rather than one
  // fetchRangeLight() over the whole [from, to] — measured directly
  // against production: a single fetch of a week's ~210k rows took
  // 2.7-5.1s in SQLite alone, before any JS work, while the identical data
  // fetched a day at a time (bounded to ~43k rows per query, same chunking
  // dailySnapshots() already uses, just plain 24h UTC steps here since
  // nothing below needs local-calendar-day alignment) came back in a
  // fraction of that.
  const CHUNK_MS = 24 * 3600 * 1000;
  for (let chunkStart = from; chunkStart < to; chunkStart += CHUNK_MS) {
    const chunkEnd = Math.min(chunkStart + CHUNK_MS - 1, to);
    for (const rec of fetchRangeLight(chunkStart, chunkEnd)) {
      accumulateSample(acc, rec.ts, rec.tp, rec.p, 1, channelKinds, producerIdx, timezone);
    }
    // node:sqlite's queries are fully synchronous — each one blocks the
    // whole event loop, including MQTT ingestion and any other concurrent
    // request, for its entire duration. Yielding here between chunks (not
    // within one — that part's unavoidably blocking either way) lets that
    // queued-up work run between chunks instead of only after the whole
    // range finishes, so a wide-range query doesn't stall live
    // readings/WebSocket delivery for its full multi-second total.
    await new Promise((resolve) => setImmediate(resolve));
  }

  return finalizeAnalytics(acc, { from, to, channelKinds, channelLabels, timezone });
}

function newAnalyticsAccumulator(timezone) {
  return {
    n: 0, // total raw-sample-count represented (weight-summed — identical meaning on both paths)
    sum: new Array(CIRCUIT_COUNT).fill(0),
    sumSq: new Array(CIRCUIT_COUNT).fill(0),
    min: new Array(CIRCUIT_COUNT).fill(Infinity),
    max: new Array(CIRCUIT_COUNT).fill(-Infinity),
    circuitKwh: new Array(CIRCUIT_COUNT).fill(0),
    hourCircuitSum: Array.from({ length: 24 }, () => new Array(CIRCUIT_COUNT).fill(0)),
    hourCount: new Array(24).fill(0),
    hourGridSum: new Array(24).fill(0),
    peak: { total: -Infinity, ts: null, p: null },
    standby: { total: Infinity, ts: null },
    importWeight: 0,
    importKwh: 0,
    exportKwh: 0,
    producedKwh: 0,
    prevRec: null,
    prevSolar: 0,
    todayStr: localDateStr(Date.now(), timezone),
    todayRows: [],
  };
}

/**
 * Folds one sample — a raw 2-second reading (weight 1) or a per-minute
 * average (weight = that minute's raw sample count) — into `acc`. The one
 * piece of logic computeAnalyticsFromAgg() and ...FromRaw() share, so
 * there's exactly one place the math between them could drift apart.
 */
function accumulateSample(acc, ts, tp, p, weight, channelKinds, producerIdx, timezone) {
  acc.n += weight;
  const hour = localHour(ts, timezone);

  let householdLoad = 0;
  let solar = 0;
  for (let i = 0; i < CIRCUIT_COUNT; i++) {
    const v = p[i] ?? 0;
    acc.sum[i] += v * weight;
    acc.sumSq[i] += v * v * weight;
    if (v < acc.min[i]) acc.min[i] = v;
    if (v > acc.max[i]) acc.max[i] = v;
    acc.hourCircuitSum[hour][i] += v * weight;
    if (channelKinds[i] !== "producer") householdLoad += v;
    else solar += v;
  }
  acc.hourCount[hour] += weight;
  acc.hourGridSum[hour] += tp * weight;
  if (tp >= 0) acc.importWeight += weight;

  if (householdLoad > acc.peak.total) acc.peak = { total: householdLoad, ts, p };
  if (householdLoad < acc.standby.total) acc.standby = { total: householdLoad, ts };

  // Trapezoidal integration needs a consecutive pair — same gap-skipping
  // rule as integrateKwh() (skip non-positive or >1h gaps, e.g. a server
  // restart). Same formula whether consecutive samples are 2 seconds or a
  // minute apart; only dtHours changes.
  const rec = { ts, tp, p };
  if (acc.prevRec) {
    const dtHours = (ts - acc.prevRec.ts) / 3_600_000;
    if (dtHours > 0 && dtHours <= 1) {
      for (let i = 0; i < CIRCUIT_COUNT; i++) {
        acc.circuitKwh[i] += (((acc.prevRec.p[i] ?? 0) + (p[i] ?? 0)) / 2) * dtHours / 1000;
      }
      acc.importKwh += ((Math.max(0, acc.prevRec.tp) + Math.max(0, tp)) / 2) * dtHours / 1000;
      acc.exportKwh += ((Math.max(0, -acc.prevRec.tp) + Math.max(0, -tp)) / 2) * dtHours / 1000;
      if (producerIdx.length) acc.producedKwh += ((acc.prevSolar + solar) / 2) * dtHours / 1000;
    }
  }
  acc.prevRec = rec;
  acc.prevSolar = solar;

  if (localDateStr(ts, timezone) === acc.todayStr) acc.todayRows.push(rec);
}

/** Turns an accumulator (see newAnalyticsAccumulator()) into the API shape — shared by both the aggregate and raw paths. */
function finalizeAnalytics(acc, { from, to, channelKinds, channelLabels, timezone }) {
  const { n, sum, sumSq, min, max, circuitKwh, hourCircuitSum, hourCount, hourGridSum, peak, standby, importWeight, importKwh, exportKwh, producedKwh, todayStr, todayRows } =
    acc;

  if (n === 0) {
    return {
      from,
      to,
      sampleCount: 0,
      circuits: [],
      byHourOfDay: [],
      byWeekday: WEEKDAY_LABELS.map((label, wd) => ({ weekday: wd, label, avgGridPower: 0, avgHouseholdPower: 0, sampleCount: 0 })),
      byWeek: [],
      gridBalance: null,
      solar: null,
      peakDemand: null,
      standbyLoad: null,
      mostVolatile: [],
    };
  }

  const producerIdx = [];
  for (let i = 0; i < CIRCUIT_COUNT; i++) if (channelKinds[i] === "producer") producerIdx.push(i);

  // --- usage by circuit ---
  const circuits = [];
  for (let i = 0; i < CIRCUIT_COUNT; i++) {
    const avg = sum[i] / n;
    const variance = Math.max(0, sumSq[i] / n - avg * avg);
    circuits.push({
      index: i,
      label: channelLabels[i] ?? `Circuit ${i + 1}`,
      kind: channelKinds[i] === "producer" ? "producer" : "consumer",
      avgPower: round2(avg),
      peakPower: round2(max[i]),
      minPower: round2(min[i]),
      stdDevPower: round2(Math.sqrt(variance)),
      kwh: round4(circuitKwh[i]),
    });
  }
  const consumedTotalKwh = circuits.filter((c) => c.kind === "consumer").reduce((s, c) => s + c.kwh, 0);
  for (const c of circuits) {
    c.sharePct = c.kind === "consumer" && consumedTotalKwh > 0 ? round2((c.kwh / consumedTotalKwh) * 100) : 0;
  }
  circuits.sort((a, b) => b.kwh - a.kwh);

  // --- typical hour-of-day pattern ---
  const byHourOfDay = [];
  for (let h = 0; h < 24; h++) {
    const count = hourCount[h];
    let topIdx = -1,
      topAvg = -Infinity;
    for (let i = 0; i < CIRCUIT_COUNT; i++) {
      if (channelKinds[i] === "producer" || count === 0) continue;
      const avg = hourCircuitSum[h][i] / count;
      if (avg > topAvg) {
        topAvg = avg;
        topIdx = i;
      }
    }
    byHourOfDay.push({
      hour: h,
      avgGridPower: count ? round2(hourGridSum[h] / count) : 0,
      sampleCount: count,
      circuitAvgPower: hourCircuitSum[h].map((s) => (count ? round2(s / count) : 0)),
      topCircuit: topIdx >= 0 ? { index: topIdx, label: channelLabels[topIdx], avgPower: round2(topAvg) } : null,
    });
  }

  // --- day-of-week + week-of-year: from the daily_stats rollup, plus today's not-yet-rolled-up partial ---
  const dailyRows = dailyRangeStmt.all(localDateStr(from, timezone), localDateStr(to, timezone));
  const todayPartial =
    todayRows.length > 0 && !dailyRows.some((d) => d.date === todayStr)
      ? {
          weekday: localWeekday(todayRows[0].ts, timezone),
          sampleCount: todayRows.length,
          avgGridPower: todayRows.reduce((s, r) => s + r.tp, 0) / todayRows.length,
          avgHouseholdPower: todayRows.reduce((s, r) => s + householdLoadOf(r, channelKinds), 0) / todayRows.length,
          importKwh: integrateKwh(todayRows, (r) => Math.max(0, r.tp)),
          exportKwh: integrateKwh(todayRows, (r) => Math.max(0, -r.tp)),
          ts: todayRows[0].ts,
        }
      : null;

  const byWeekday = byWeekdayFromDaily(dailyRows, todayPartial);
  const byWeek = byWeekFromDaily(dailyRows, todayPartial, timezone);

  // --- grid balance + solar self-consumption ---
  // importKwh/exportKwh/producedKwh already accumulated by accumulateSample().
  const gridBalance = {
    importPct: round2((importWeight / n) * 100),
    exportPct: round2(((n - importWeight) / n) * 100),
    importKwh: round4(importKwh),
    exportKwh: round4(exportKwh),
    netKwh: round4(importKwh - exportKwh),
  };

  let solar = null;
  if (producerIdx.length) {
    const selfConsumedKwh = Math.max(0, producedKwh - exportKwh);
    solar = {
      producedKwh: round4(producedKwh),
      exportedKwh: round4(exportKwh),
      selfConsumedKwh: round4(selfConsumedKwh),
      selfConsumedPct: producedKwh > 0 ? round2((selfConsumedKwh / producedKwh) * 100) : 0,
    };
  }

  // --- notable metrics ---
  let peakTopCircuit = null;
  if (peak.p) {
    let bi = -1,
      bv = -Infinity;
    for (let i = 0; i < CIRCUIT_COUNT; i++) {
      if (channelKinds[i] !== "producer" && (peak.p[i] ?? 0) > bv) {
        bv = peak.p[i] ?? 0;
        bi = i;
      }
    }
    if (bi >= 0) peakTopCircuit = { index: bi, label: channelLabels[bi], power: round2(bv) };
  }
  const mostVolatile = circuits
    .filter((c) => c.avgPower > 5)
    .slice()
    .sort((a, b) => b.stdDevPower - a.stdDevPower)
    .slice(0, 5);

  return {
    from,
    to,
    sampleCount: n,
    circuits,
    byHourOfDay,
    byWeekday,
    byWeek,
    gridBalance,
    solar,
    peakDemand: peak.ts ? { ts: peak.ts, totalPower: round2(peak.total), topCircuit: peakTopCircuit } : null,
    standbyLoad: standby.ts ? { ts: standby.ts, totalPower: round2(standby.total) } : null,
    mostVolatile,
  };
}

function byWeekdayFromDaily(dailyRows, todayPartial) {
  const sumGrid = new Array(7).fill(0);
  const sumHousehold = new Array(7).fill(0);
  const count = new Array(7).fill(0);
  for (const d of dailyRows) {
    sumGrid[d.weekday] += d.avgGridPower * d.sampleCount;
    sumHousehold[d.weekday] += d.avgHouseholdPower * d.sampleCount;
    count[d.weekday] += d.sampleCount;
  }
  if (todayPartial) {
    const wd = todayPartial.weekday;
    sumGrid[wd] += todayPartial.avgGridPower * todayPartial.sampleCount;
    sumHousehold[wd] += todayPartial.avgHouseholdPower * todayPartial.sampleCount;
    count[wd] += todayPartial.sampleCount;
  }
  return WEEKDAY_LABELS.map((label, wd) => ({
    weekday: wd,
    label,
    avgGridPower: count[wd] ? round2(sumGrid[wd] / count[wd]) : 0,
    avgHouseholdPower: count[wd] ? round2(sumHousehold[wd] / count[wd]) : 0,
    sampleCount: count[wd],
  }));
}

function byWeekFromDaily(dailyRows, todayPartial, timezone) {
  const weekMap = new Map();
  const add = (weekStart, importKwh, exportKwh) => {
    let w = weekMap.get(weekStart);
    if (!w) {
      w = { weekStart, importKwh: 0, exportKwh: 0 };
      weekMap.set(weekStart, w);
    }
    w.importKwh += importKwh;
    w.exportKwh += exportKwh;
  };
  for (const d of dailyRows) add(weekStartTs(dayBounds(d.date, timezone).from, timezone), d.importKwh, d.exportKwh);
  if (todayPartial) add(weekStartTs(todayPartial.ts, timezone), todayPartial.importKwh, todayPartial.exportKwh);

  return [...weekMap.values()]
    .sort((a, b) => a.weekStart - b.weekStart)
    .map((w) => ({
      weekStart: w.weekStart,
      label: new Date(w.weekStart).toLocaleDateString(undefined, { timeZone: timezone, month: "short", day: "numeric" }),
      importKwh: round4(w.importKwh),
      exportKwh: round4(w.exportKwh),
      netKwh: round4(w.importKwh - w.exportKwh),
    }));
}

/** Trapezoidal integration of a per-record value (W) into kWh over time; skips gaps > 1h. */
function integrateKwh(recs, valueFn) {
  let kwh = 0;
  for (let i = 1; i < recs.length; i++) {
    const dtHours = (recs[i].ts - recs[i - 1].ts) / 3_600_000;
    if (dtHours <= 0 || dtHours > 1) continue;
    const v1 = valueFn(recs[i - 1]);
    const v2 = valueFn(recs[i]);
    kwh += (((v1 + v2) / 2) * dtHours) / 1000;
  }
  return kwh;
}

/** UTC epoch ms for local midnight of the Monday starting the week containing `ts`, as reckoned in `timezone`. */
function weekStartTs(ts, timezone) {
  const [y, mo, d] = localDateStr(ts, timezone).split("-").map(Number);
  const weekday = localWeekday(ts, timezone); // 0=Sun..6=Sat
  // Plain calendar arithmetic from here — a throwaway server-local Date
  // object is only ever used to derive calendar numbers (year/month/day),
  // never treated as a real timezone-aware instant, same convention
  // dailyEmail.js's daysBeforeStr() already uses for the same reason.
  const monday = new Date(y, mo - 1, d - (weekday === 0 ? 6 : weekday - 1));
  const mondayDs = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
  return localDateToUtcMs(mondayDs, timezone);
}

function sumMains(arr) {
  return MAIN_INDEXES.reduce((s, i) => s + (arr[i] ?? 0), 0);
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
