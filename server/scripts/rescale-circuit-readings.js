#!/usr/bin/env node
// One-time (or rerunnable) rescale of every stored reading's *circuit*
// channels (index 0-15) only, by a given factor — leaves the 3 main
// channels and the derived `tp` (mains-only total power) column untouched.
//
// Exists because the original power-calibration fix (see channels.js and
// rescale-readings.js) applied its correction factor to *every* channel,
// including the 16 individually-clamped circuits — but that correction's
// underlying cause (a three-phase power formula misapplied to a 2-leg
// split-phase mains reading) is specific to how the 3 main legs get
// combined, and never applies to a single circuit's own clamp. Confirmed
// against real data: two full days of this installation's solar
// production, compared to the solar company's own daily figures for the
// same two days, were low by the same ~√3 the mains fix corrects for —
// meaning the circuit channels had been *over*-corrected by that same
// factor. This script undoes it for existing history; channels.js now
// only ever applies the calibration factor to mains channels going
// forward, so this is a one-time catch-up, not an ongoing correction.
//
// Usage (from server/):
//   node scripts/rescale-circuit-readings.js <factor>
//   e.g. node scripts/rescale-circuit-readings.js 1.7320508075688772   (= 1 / (1/sqrt3), undoing that factor)
import { CIRCUIT_COUNT, MAIN_INDEXES } from "../src/channels.js";
import { db } from "../src/db.js";

const factor = Number(process.argv[2]);
if (!Number.isFinite(factor) || factor <= 0) {
  console.error("Usage: node rescale-circuit-readings.js <factor>  (a positive number)");
  process.exit(1);
}

const rows = db.prepare("SELECT id, p, eIn, eOut FROM readings").all();
console.log(`Rescaling circuit channels (0-${CIRCUIT_COUNT - 1}) of ${rows.length} readings by factor ${factor}...`);
console.log(`Main channels (${MAIN_INDEXES.join(", ")}) and tp are left untouched.`);

const updateStmt = db.prepare("UPDATE readings SET p = ?, eIn = ?, eOut = ? WHERE id = ?");
const rescaleCircuitsOnly = (json) =>
  JSON.stringify(JSON.parse(json).map((v, i) => (i < CIRCUIT_COUNT ? v * factor : v)));

db.exec("BEGIN");
for (const row of rows) {
  updateStmt.run(rescaleCircuitsOnly(row.p), rescaleCircuitsOnly(row.eIn), rescaleCircuitsOnly(row.eOut), row.id);
}
db.exec("COMMIT");
console.log(`Done. Rescaled ${rows.length} rows.`);

// Both rollup/cache tables derive circuit-level figures (avgHouseholdPower,
// biggestCircuit, peakProduction, etc.) from the raw readings at the old
// scale — clear them so they recompute from the now-corrected data.
// initStore()'s rollupMissingDays() catch-up sweep rebuilds daily_stats
// automatically on next start; daily_snapshots self-heals lazily, one day
// at a time, the next time each day is actually viewed (see store.js).
const clearedStats = db.prepare("DELETE FROM daily_stats").run();
console.log(`Cleared ${clearedStats.changes} daily_stats rollup row(s).`);
const clearedSnapshots = db.prepare("DELETE FROM daily_snapshots").run();
console.log(`Cleared ${clearedSnapshots.changes} daily_snapshots cache row(s).`);
