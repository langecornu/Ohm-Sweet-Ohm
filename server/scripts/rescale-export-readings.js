#!/usr/bin/env node
// One-time rescale of every stored reading the app's own direction
// convention already calls "exporting" (tp < 0): undoes the mains
// calibration factor on `tp` and the 3 main channels' stored `p[]` values,
// for those rows only. See index.js's withGridDirection() header comment
// and README's "Power calibration" section for the full reasoning — the
// factor was derived and validated against import-direction data only. A
// direct SDGE 15-minute CSV comparison across 4 independent full days
// showed import staying within ordinary tolerance while export ran a
// consistent ~42-46% low once calibrated — almost exactly what applying
// the factor a second time would look like, since the raw (uncalibrated)
// export magnitude already matched the utility's own Generation figures
// closely. channels.js/index.js now apply this correctly going forward
// (calibrating mains only while importing); this script is the one-time
// catch-up for existing history.
//
// Usage (from server/, with the app stopped — avoids racing live inserts):
//   node scripts/rescale-export-readings.js <calibrationFactor>
//   e.g. node scripts/rescale-export-readings.js 0.5773502691896258
import { MAIN_INDEXES } from "../src/channels.js";
import { db } from "../src/db.js";

const factor = Number(process.argv[2]);
if (!Number.isFinite(factor) || factor <= 0) {
  console.error("Usage: node rescale-export-readings.js <calibrationFactor>  (a positive number)");
  process.exit(1);
}

const mainSet = new Set(MAIN_INDEXES);
const rows = db.prepare("SELECT id, tp, p FROM readings WHERE tp < 0").all();
console.log(`Found ${rows.length} export-direction reading(s) (tp < 0) of the total in the table.`);
console.log(`Undoing calibration factor ${factor} on tp and main channels (${MAIN_INDEXES.join(", ")}) for those rows...`);

const updateStmt = db.prepare("UPDATE readings SET tp = ?, p = ? WHERE id = ?");
const round2 = (n) => Math.round(n * 100) / 100;

db.exec("BEGIN");
for (const row of rows) {
  const p = JSON.parse(row.p).map((v, i) => (mainSet.has(i) ? round2(v / factor) : v));
  const newTp = round2(row.tp / factor); // tp is negative; dividing by factor<1 grows the magnitude, sign unchanged
  updateStmt.run(newTp, JSON.stringify(p), row.id);
}
db.exec("COMMIT");
console.log(`Done. Rescaled ${rows.length} rows.`);

// Same reasoning as the other rescale scripts: clear the rollup caches so
// they recompute from the now-corrected data instead of serving stale
// pre-rescale figures.
const clearedStats = db.prepare("DELETE FROM daily_stats").run();
console.log(`Cleared ${clearedStats.changes} daily_stats rollup row(s).`);
const clearedSnapshots = db.prepare("DELETE FROM daily_snapshots").run();
console.log(`Cleared ${clearedSnapshots.changes} daily_snapshots cache row(s).`);
