// Shared "what will this look like on the bill" estimator — used by both
// the daily email (for the real electric billing cycle) and the Daily
// Snapshots page's billing-cycle cost tracker (for whichever period the
// user has selected there). Kept in one place so the tier/cost math can't
// drift between the two surfaces — see sdgeRates.js for the underlying
// rate figures and tierSplit()/estimateCost() themselves.
import { dailySnapshots } from "./store.js";
import { getSdgeRates, estimateCost } from "./sdgeRates.js";

/** Net grid draw for a day/snapshot — pulled from grid minus pushed back to it. */
function netKwhOf(d) {
  return (d?.gridImportKwh ?? 0) - (d?.gridExportKwh ?? 0);
}

/**
 * Estimates SDGE cost for the local half-open day range [fromMs, toMs),
 * projected out to the full range length at the rate seen so far. `toMs`
 * is clamped to `nowMs` (defaults to the real current time) so a range
 * extending into the future — a billing cycle still in progress — only
 * counts days that have actually happened; a fully-elapsed past range is
 * unaffected by the clamp and the "projection" just equals the actual
 * total. Pass an explicit `nowMs` (e.g. the end of a specific reported
 * day) when the caller needs "as of that day," not "as of right now" —
 * the daily email does this so a test send for an old date doesn't pull in
 * days that happened after the date being reported. `cycleDays` overrides the
 * full-cycle length used for the tier boundary (see estimateCost) when `toMs`
 * isn't the real end of the cycle — the email's "cost through the day
 * before" calculation.
 */
export function estimatePeriodCost({ fromMs, toMs, timezone, channelKinds, channelLabels, nowMs = Date.now(), cycleDays }) {
  const elapsedToMs = Math.min(toMs, nowMs);
  const days = elapsedToMs > fromMs ? dailySnapshots({ from: fromMs, to: elapsedToMs, channelKinds, channelLabels, timezone }) : [];
  const netKwh = days.reduce((s, d) => s + netKwhOf(d), 0);
  const daysElapsed = days.length;
  const totalDays = cycleDays ?? Math.max(1, Math.round((toMs - fromMs) / 86400000));
  // Rate lookup uses whichever day the elapsed data actually reaches (or
  // the range start, if none yet) — the only thing that matters is picking
  // the right season.
  const refDate = new Date(elapsedToMs > fromMs ? elapsedToMs - 1 : fromMs);
  const rates = getSdgeRates(refDate);
  // Tier boundary is the whole cycle's (130% of baseline x totalDays), not
  // prorated to the days elapsed: SDGE tiers cumulative usage over the cycle.
  const costToDate = estimateCost(netKwh, daysElapsed, rates, totalDays);
  const projectedNetKwh = daysElapsed > 0 ? (netKwh / daysElapsed) * totalDays : 0;
  const costProjected = estimateCost(projectedNetKwh, totalDays, rates);
  return { daysElapsed, totalDays, daysRemaining: Math.max(0, totalDays - daysElapsed), netKwh, costToDate, projectedNetKwh, costProjected, rates };
}

// The Daily Snapshots page's "Tracking toward your bill" card defaults to
// the *current* electric billing cycle, so that's the one request every
// page load makes — same reasoning as store.js's live-snapshot cache
// (see README): rather than let that request run estimatePeriodCost()
// (a dailySnapshots() scan across the whole cycle) live, and risk it
// getting queued behind the hourly analytics job's synchronous chunks, the
// scheduler recomputes this exact cycle every 15 minutes and requests just
// read the cached value — including `computedAt`, so the UI can show a
// real "as of" time instead of implying it's live-live.
let currentCycleCache = null; // { fromMs, toMs, estimate, computedAt }

/** Recomputes the estimate for [fromMs, toMs) and caches it as "the current cycle" — called only by scheduledJobs.js's 15-minute timer. */
export function refreshCurrentCycleCost({ fromMs, toMs, timezone, channelKinds, channelLabels }) {
  const estimate = estimatePeriodCost({ fromMs, toMs, timezone, channelKinds, channelLabels });
  currentCycleCache = { fromMs, toMs, estimate, computedAt: Date.now() };
  return currentCycleCache;
}

/** Returns the cached estimate only if it's for exactly this range (i.e. this *is* "the current cycle" the scheduler is keeping warm) — null otherwise, so the caller falls back to computing it live. */
export function getCachedCycleCost(fromMs, toMs) {
  return currentCycleCache && currentCycleCache.fromMs === fromMs && currentCycleCache.toMs === toMs ? currentCycleCache : null;
}
