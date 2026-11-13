#!/usr/bin/env node
// One-time catch-up for the import correction (calibration.js's
// getImportCorrection(), applied going forward by index.js's
// withGridDirection()): rewrites every stored reading the app's own
// convention calls "importing" (tp > 0) to (tp - offsetW) / gain, floored
// at 0, scaling the 3 main channels' stored p[] by the same ratio. Fit and
// validation numbers are in README's "Power calibration" section.
//
// Usage (from server/, with the app stopped — avoids racing live inserts):
//   node scripts/rescale-import-readings.js <gain> <offsetW>
//   e.g. node scripts/rescale-import-readings.js 0.883 137
// Then rebuild the per-minute aggregate: node scripts/backfill-minute-agg.js
// Run once per correction — applying it twice compounds it.
import { MAIN_INDEXES } from "../src/channels.js";
import { db } from "../src/db.js";
import { correctImportWatts } from "../src/calibration.js";

const gain = Number(process.argv[2]);
const offsetW = Number(process.argv[3]);
if (!Number.isFinite(gain) || gain <= 0 || !Number.isFinite(offsetW)) {
  console.error("Usage: node rescale-import-readings.js <gain> <offsetW>   e.g. 0.883 137");
  process.exit(1);
}

const mainSet = new Set(MAIN_INDEXES);
const { n: total } = db.prepare("SELECT COUNT(*) AS n FROM readings WHERE tp > 0").get();
console.log(`Found ${total} import-direction reading(s) (tp > 0).`);
console.log(`Applying (tp - ${offsetW}) / ${gain} to tp and main channels (${MAIN_INDEXES.join(", ")})...`);

// Read in id-ordered batches (the full set doesn't fit comfortably in the
// production VM's ~1GB), but inside ONE transaction: a crash part-way rolls
// everything back instead of leaving some rows corrected and others not —
// re-running after a partial commit would double-correct those rows.
const BATCH = 20_000;
const batchStmt = db.prepare("SELECT id, tp, p FROM readings WHERE tp > 0 AND id > ? ORDER BY id LIMIT ?");
const updateStmt = db.prepare("UPDATE readings SET tp = ?, p = ? WHERE id = ?");
const round2 = (n) => Math.round(n * 100) / 100;

let done = 0;
let lastId = -1;
db.exec("BEGIN");
for (;;) {
  const rows = batchStmt.all(lastId, BATCH);
  if (rows.length === 0) break;
  for (const row of rows) {
    const newTp = correctImportWatts(row.tp, { gain, offsetW });
    const ratio = newTp / row.tp;
    const p = JSON.parse(row.p).map((v, i) => (mainSet.has(i) ? round2(v * ratio) : v));
    updateStmt.run(round2(newTp), JSON.stringify(p), row.id);
  }
  lastId = rows[rows.length - 1].id;
  done += rows.length;
  console.log(`  ${done}/${total}`);
}
db.exec("COMMIT");
console.log(`Done. Rescaled ${done} rows.`);

// Same as the other rescale scripts: clear the rollup caches so they
// recompute from the corrected data.
const clearedStats = db.prepare("DELETE FROM daily_stats").run();
console.log(`Cleared ${clearedStats.changes} daily_stats rollup row(s).`);
const clearedSnapshots = db.prepare("DELETE FROM daily_snapshots").run();
console.log(`Cleared ${clearedSnapshots.changes} daily_snapshots cache row(s).`);
console.log("Now run: node scripts/backfill-minute-agg.js");
