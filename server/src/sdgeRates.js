// SDGE "Standard - DR-Residential" rate figures for this account, extracted
// directly from a real bill (Aug 5 – Sep 2, 2026 cycle, Inland climate
// zone) — see README's "Daily email report" section. Net-metered: the bill
// itself confirms "Credits and charges are calculated using the same
// currently approved rates," meaning import and export both net against
// these same tiered rates, true-up annually (this account's is May 5).
//
// These are SUMMER rates and a SUMMER baseline allowance — SDGE's tiers and
// baseline shift seasonally (typically summer ~June-Oct, winter the rest of
// the year), and this file only has the one season's numbers. When a
// winter bill comes in, update WINTER below to match rather than guessing.
// Until then, winter months fall back to the summer figures with a lower
// confidence flag the email can note.
//
// Tier structure (from the bill's own detail page): Tier 1 is usage up to
// 130% of the baseline allowance, Tier 2 everything above it — for the Aug 5
// - Sep 2 bill (29 days, 302 kWh baseline) that's 392 kWh at Tier 1 and the
// remaining 558 kWh at Tier 2. The tier boundary is measured on the
// *cumulative* net usage of the whole billing cycle, so it scales with the
// cycle's total length, not with how many days have elapsed so far.
//
// The per-kWh rates are the all-in totals reconstructed from that same
// page's itemized lines: delivery (0.219 Tier 1 / 0.32601 Tier 2) +
// generation 0.18808 + wildfire fund 0.00591 + state surcharge tax 0.0003 +
// regulatory fee 0.001. Checked against the bill: 392 x 0.41429 + 558 x
// 0.52130 = $453.28 vs the bill's "NEM charges" of $453.35 for 950 kWh
// (the cent-level gap is the 1.1% franchise fee on the wildfire line).
//
// Re-verified against the next bill (Sep 3 - Oct 2, 2026, 30 days, still
// "SUMMER USAGE"): identical per-kWh rates and base charge, 312 kWh
// baseline -> 406 kWh Tier 1; 406 x 0.41429 + 19 x 0.5213 = $178.10 vs the
// bill's NEM charges of $178.13 for 425 kWh. Baseline per day is 10.40 vs
// the earlier bill's 10.41 — the same allowance, rounded per cycle.
const SUMMER = {
  tier1RatePerKwh: 0.41429,
  tier2RatePerKwh: 0.5213,
  baselineKwhPerDay: 312 / 30, // 100% of baseline: 312 kWh over the Sep 3 - Oct 2 cycle's 30 billing days
  tier1BaselineFactor: 1.3, // Tier 1 ends at 130% of baseline
  baseServiceChargePerDay: 0.79343,
};

// No winter figures yet — reuse summer's as a rough stand-in until a
// winter bill is available to replace this.
const WINTER = { ...SUMMER };

const ASOF_BILL_DATE = "2026-10-06";

/** SDGE's summer season is roughly June through October; the rest is
 * winter. Rough boundary — good enough for picking which rate set to use,
 * not exact CPUC tariff-effective dates. */
function isSummer(date) {
  const month = date.getMonth() + 1; // 1-12
  return month >= 6 && month <= 10;
}

/** Rate figures for a given JS Date (defaults to now), plus whether this
 * is the (currently only) verified season. */
export function getSdgeRates(date = new Date()) {
  const summer = isSummer(date);
  return { ...(summer ? SUMMER : WINTER), season: summer ? "summer" : "winter", verified: summer, asOfBillDate: ASOF_BILL_DATE };
}

/** Splits `netKwh` (this period's cumulative net usage so far — pulled
 * from grid minus pushed back to it) into Tier 1 (up to the boundary) and
 * Tier 2 (the rest) portions. A net-negative period (net export) has zero
 * tier usage — SDGE's netting means that period is building NEM credit
 * instead of owing tier charges, not literally "negative usage." */
export function tierSplit(netKwh, baselineKwh) {
  const usageKwh = Math.max(0, netKwh);
  const tier1Kwh = Math.min(usageKwh, baselineKwh);
  const tier2Kwh = Math.max(0, usageKwh - baselineKwh);
  return { tier1Kwh, tier2Kwh };
}

/** Estimated bill for `netKwh` of net usage over `days` days, using `rates`
 * (see getSdgeRates). `cycleDays` is the length of the *whole* billing
 * cycle the Tier 1 boundary is measured over (defaults to `days`, i.e. "as
 * if the cycle ended now"); pass the real cycle length for a cycle still in
 * progress so the boundary doesn't shrink to the days elapsed so far.
 * `baselineKwh` in the result is that Tier 1 boundary (130% of baseline).
 * Deliberately doesn't model the twice-yearly California Climate Credit,
 * banked NEM credits from earlier months, or other one-off adjustments —
 * this is "what the tiered usage + base charge come to" (the bill's "NEM
 * charges" plus base service charge), not a full bill reproduction. */
export function estimateCost(netKwh, days, rates, cycleDays = days) {
  const baselineKwh = rates.baselineKwhPerDay * rates.tier1BaselineFactor * cycleDays;
  const { tier1Kwh, tier2Kwh } = tierSplit(netKwh, baselineKwh);
  const usageCost = tier1Kwh * rates.tier1RatePerKwh + tier2Kwh * rates.tier2RatePerKwh;
  const baseCost = rates.baseServiceChargePerDay * days;
  return { baselineKwh, tier1Kwh, tier2Kwh, usageCost, baseCost, totalCost: usageCost + baseCost };
}
