#!/usr/bin/env node
// One-time rescale of specific channel indexes' stored power/energy by a
// given factor, leaving every other channel (and `tp`, the mains-only
// total) untouched. The general-purpose sibling of rescale-readings.js
// (all channels) and rescale-circuit-readings.js (all 16 circuits) — this
// one is for a per-circuit calibration factor set in Settings (see
// channelConfig.js's header comment), where only one or two indexes need
// correcting, e.g. a compressor motor's clamp reading apparent power
// rather than true power. Existing history predates the factor, so this
// is a one-time catch-up; channelConfig.js applies it to new readings
// going forward on its own.
//
// Usage (from server/):
//   node scripts/rescale-channel-indexes.js <factor> <index> [index...]
//   e.g. node scripts/rescale-channel-indexes.js 0.73 2 3   (Aircon Phase 1/2)
import { CHANNEL_COUNT, MAIN_INDEXES } from "../src/channels.js";
import { db } from "../src/db.js";

const [factorArg, ...indexArgs] = process.argv.slice(2);
const factor = Number(factorArg);
const indexes = indexArgs.map(Number);

if (!Number.isFinite(factor) || factor <= 0 || indexes.length === 0 || indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= CHANNEL_COUNT)) {
  console.error("Usage: node rescale-channel-indexes.js <factor> <index> [index...]");
  console.error(`  factor: a positive number.  index: 0-${CHANNEL_COUNT - 1}.`);
  process.exit(1);
}
if (indexes.some((i) => MAIN_INDEXES.includes(i))) {
  console.error(`Refusing: index ${indexes.find((i) => MAIN_INDEXES.includes(i))} is a main channel — use the mains-wide calibration factor instead (rescale-readings.js).`);
  process.exit(1);
}

const indexSet = new Set(indexes);
const rows = db.prepare("SELECT id, p, eIn, eOut FROM readings").all();
console.log(`Rescaling channel(s) ${[...indexSet].join(", ")} of ${rows.length} readings by factor ${factor}...`);

const updateStmt = db.prepare("UPDATE readings SET p = ?, eIn = ?, eOut = ? WHERE id = ?");
const rescale = (json) => JSON.stringify(JSON.parse(json).map((v, i) => (indexSet.has(i) ? v * factor : v)));

db.exec("BEGIN");
for (const row of rows) {
  updateStmt.run(rescale(row.p), rescale(row.eIn), rescale(row.eOut), row.id);
}
db.exec("COMMIT");
console.log(`Done. Rescaled ${rows.length} rows.`);

// Same reasoning as rescale-circuit-readings.js: clear the rollup caches so
// they recompute from the now-corrected data instead of serving stale
// pre-rescale figures.
const clearedStats = db.prepare("DELETE FROM daily_stats").run();
console.log(`Cleared ${clearedStats.changes} daily_stats rollup row(s).`);
const clearedSnapshots = db.prepare("DELETE FROM daily_snapshots").run();
console.log(`Cleared ${clearedSnapshots.changes} daily_snapshots cache row(s).`);
