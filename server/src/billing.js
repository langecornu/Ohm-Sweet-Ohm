// Billing period preferences for the Daily Snapshots page: two independent
// "day of month the cycle starts" values — the solar company's bill and
// the electric utility's bill often don't run on the same cycle, or on the
// calendar month — so totals can be aligned to either and checked directly
// against the real bill.
import { db } from "./db.js";

const getStmt = db.prepare("SELECT value FROM app_settings WHERE key = ?");
const setStmt = db.prepare(
  "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

// `electricReadDates`: SDGE's actual meter-read dates ("YYYY-MM-DD", each
// one the last day of the cycle it closes — the bill's "Billing Period:
// 9/3/26 - 10/2/26" ends on the 10/2 read). SDGE doesn't read on a fixed day
// of the month — this account's reads have landed on the 4th, 6th, 4th, 2nd,
// 2nd and (scheduled) 3rd — so a single `electricBillingDay` drifts a few
// days off the real cycle within a couple of months. When read dates are
// set they define the electric cycle outright; `electricBillingDay` is only
// the fallback when none are.
const DEFAULTS = { solarBillingDay: 1, electricBillingDay: 1, electricReadDates: [] };

export function getBillingSettings() {
  const row = getStmt.get("billing_settings");
  return row ? { ...DEFAULTS, ...JSON.parse(row.value) } : { ...DEFAULTS };
}

export function setBillingSettings(patch) {
  const next = { ...getBillingSettings(), ...patch };
  setStmt.run("billing_settings", JSON.stringify(next));
  return next;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * "YYYY-MM-DD" of the start of the billing cycle that contains `ds`
 * (a "YYYY-MM-DD"), given the cycle's start day-of-month. A `billingDay`
 * past the end of a given month (e.g. 31 in a 30-day month) clamps to that
 * month's last day, the same convention utilities themselves use for
 * cycles that start near month-end.
 */
export function billingCycleStart(ds, billingDay) {
  const [y, m, d] = ds.split("-").map(Number);
  const clampedThisMonth = Math.min(billingDay, daysInMonth(y, m));
  let cy = y,
    cm = m;
  if (d < clampedThisMonth) {
    cm -= 1;
    if (cm === 0) {
      cm = 12;
      cy -= 1;
    }
  }
  const clamped = Math.min(billingDay, daysInMonth(cy, cm));
  return `${cy}-${String(cm).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" of the start of the NEXT billing cycle after the one containing `ds` — i.e. the exclusive end of the current cycle. */
export function billingCycleEnd(ds, billingDay) {
  const start = billingCycleStart(ds, billingDay);
  const [y, m] = start.split("-").map(Number);
  let ny = y,
    nm = m + 1;
  if (nm === 13) {
    nm = 1;
    ny += 1;
  }
  const clamped = Math.min(billingDay, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" `n` calendar days after `ds`. */
function addDaysStr(ds, n) {
  const [y, m, d] = ds.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + n));
  return next.toISOString().slice(0, 10);
}

/**
 * { start, end } ("YYYY-MM-DD", end exclusive) of the electric billing
 * cycle containing `ds`. With known meter-read dates, a cycle runs from the
 * day after one read through the next read, inclusive. Before the first
 * known read the cycle just ends at that read (start falls back to the
 * day-of-month rule); after the last one, cycles repeat on that read's
 * day-of-month — an estimate until the next bill gives the real date.
 */
export function electricCycleRange(ds, settings = getBillingSettings()) {
  const reads = [...(settings.electricReadDates ?? [])].sort();
  if (reads.length === 0) {
    return { start: billingCycleStart(ds, settings.electricBillingDay), end: billingCycleEnd(ds, settings.electricBillingDay) };
  }
  const i = reads.findIndex((r) => ds <= r);
  if (i > 0) return { start: addDaysStr(reads[i - 1], 1), end: addDaysStr(reads[i], 1) };
  if (i === 0) {
    const end = addDaysStr(reads[0], 1);
    return { start: billingCycleStart(ds, Number(end.slice(8))), end };
  }
  const lastEnd = addDaysStr(reads[reads.length - 1], 1);
  const day = Math.min(28, Number(lastEnd.slice(8)));
  const start = billingCycleStart(ds, day);
  return { start: start < lastEnd ? lastEnd : start, end: billingCycleEnd(ds, day) };
}

/** Whole calendar days between two "YYYY-MM-DD" strings (b - a). */
export function daysBetween(dsA, dsB) {
  const [ay, am, ad] = dsA.split("-").map(Number);
  const [by, bm, bd] = dsB.split("-").map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}
