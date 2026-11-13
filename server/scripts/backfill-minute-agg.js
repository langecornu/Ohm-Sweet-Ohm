// One-off (and safe to re-run): builds/refreshes the per-minute aggregate
// table (readings_1m) from the raw readings, newest day first.
//
// Newest-first matters: queryHistory() serves a range from the aggregate
// only if the table's oldest minute is at or before the range's start, so
// working backwards means every point in time at or after the current
// oldest minute is already complete — a partially finished run can never
// make a chart silently miss data.
//
// Also re-run it after anything that rewrites historical raw readings (the
// rescale-*.js scripts), since the aggregate is derived from them.
//   node scripts/backfill-minute-agg.js
import { aggregateRange, earliestTimestamp } from "../src/store.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const minTs = earliestTimestamp();
if (minTs == null) {
  console.log("no readings — nothing to do");
  process.exit(0);
}
const started = Date.now();
let total = 0;
for (let to = Math.floor(Date.now() / MINUTE) * MINUTE; to > minTs; to -= DAY) {
  const from = Math.max(Math.floor(minTs / MINUTE) * MINUTE, to - DAY);
  const n = aggregateRange(from, to);
  total += n;
  console.log(`${new Date(from).toISOString().slice(0, 10)}  ${n} minutes  (${((Date.now() - started) / 1000).toFixed(0)}s elapsed)`);
}
console.log(`done: ${total} minute rows in ${((Date.now() - started) / 1000).toFixed(0)}s`);
