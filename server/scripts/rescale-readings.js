#!/usr/bin/env node
// One-time (or rerunnable) rescale of every stored reading's power/energy
// values by a given factor — used to bring existing history onto the same
// scale as a newly-applied power calibration factor (see calibration.js),
// so past and future readings agree. Only tp/p/eIn/eOut are touched;
// voltage/current are untouched (the calibration factor only ever applies
// to power/energy — see channels.js).
//
// Usage (from server/):
//   node scripts/rescale-readings.js <factor>
//   e.g. node scripts/rescale-readings.js 0.5774
import { db } from "../src/db.js";

const factor = Number(process.argv[2]);
if (!Number.isFinite(factor) || factor <= 0) {
  console.error("Usage: node rescale-readings.js <factor>  (a positive number)");
  process.exit(1);
}

const rows = db.prepare("SELECT id, tp, p, eIn, eOut FROM readings").all();
console.log(`Rescaling ${rows.length} readings by factor ${factor}...`);

const updateStmt = db.prepare("UPDATE readings SET tp = ?, p = ?, eIn = ?, eOut = ? WHERE id = ?");
const rescaleArr = (json) => JSON.stringify(JSON.parse(json).map((v) => v * factor));

db.exec("BEGIN");
for (const row of rows) {
  updateStmt.run(row.tp * factor, rescaleArr(row.p), rescaleArr(row.eIn), rescaleArr(row.eOut), row.id);
}
db.exec("COMMIT");
console.log(`Done. Rescaled ${rows.length} rows.`);

// daily_stats is a rollup computed from the raw readings at the old scale —
// clear it so it gets recomputed from the now-corrected data on next start
// (initStore()'s rollupMissingDays() catch-up sweep handles this automatically).
const cleared = db.prepare("DELETE FROM daily_stats").run();
console.log(`Cleared ${cleared.changes} daily_stats rollup row(s) — will be recomputed from corrected data.`);
