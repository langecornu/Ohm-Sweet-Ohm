// Daily email report: a rich HTML recap sent once a day, right after a
// local calendar day finishes (triggered from index.js's
// maybeRollupYesterday(), the same lazy day-change detection already used
// for the sunrise/sunset cache and the daily_snapshots rollup). Reuses
// exactly the same cached day data that feeds the Daily Snapshots page —
// no separate computation path to keep in sync.
import { db } from "./db.js";
import { dailySnapshots } from "./store.js";
import { getDayWarmest } from "./weather.js";
import { dayStartUtcMs, localDateToUtcMs } from "./tz.js";
import { sendDailyReportEmail } from "./mail.js";
import { electricCycleRange } from "./billing.js";
import { estimatePeriodCost } from "./billingCost.js";

const getSettingStmt = db.prepare("SELECT value FROM app_settings WHERE key = ?");
const setSettingStmt = db.prepare(
  "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

const DEFAULTS = { enabled: false, address: "" };

export function getDailyEmailSettings() {
  const row = getSettingStmt.get("daily_email_settings");
  return row ? { ...DEFAULTS, ...JSON.parse(row.value) } : { ...DEFAULTS };
}

export function setDailyEmailSettings(patch) {
  const next = { ...getDailyEmailSettings(), ...patch };
  setSettingStmt.run("daily_email_settings", JSON.stringify(next));
  return next;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
function round0(n) {
  return Math.round(n);
}

function daysInMonth(year, month) {
  // Day 0 of the *next* month is the last day of `month` — a standard JS
  // Date trick. Only the day-of-month component is used, so this is plain
  // calendar arithmetic, not a wall-clock instant — no timezone involved.
  return new Date(year, month, 0).getDate();
}

/** "YYYY-MM-DD" of the day before `ds`, as plain calendar arithmetic (no timezone conversion needed for this — just decrementing a calendar date). */
export function dayBeforeStr(ds) {
  return daysBeforeStr(ds, 1);
}

/** "YYYY-MM-DD" `n` calendar days before `ds` — plain calendar arithmetic, same as dayBeforeStr(). */
function daysBeforeStr(ds, n) {
  const [y, m, d] = ds.split("-").map(Number);
  const prev = new Date(y, m - 1, d - n);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
}

function pctChange(now, before) {
  if (!Number.isFinite(before) || before <= 0) return null;
  return ((now - before) / before) * 100;
}

/** Net grid draw for a day/snapshot — pulled from grid minus pushed back to it. This, not gross consumption, is what NEM billing actually nets against the tiered rate (see sdgeRates.js). */
function netKwhOf(d) {
  return (d?.gridImportKwh ?? 0) - (d?.gridExportKwh ?? 0);
}

function fmtTime(ts, timezone) {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone });
}

/** "Sep 2" — for date *ranges*, where a weekday name would be ambiguous/redundant (unlike fmtDate, used for a single referenced day). */
function fmtShortDate(ds) {
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDate(ds) {
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/**
 * Gathers everything the report needs for local calendar day `ds`
 * (already-finished — this always runs the morning after, or on-demand for
 * a test send). `yesterdaySnapshot` is the value persistDailySnapshotIfComplete()
 * just handed back, if the caller already has it (avoids recomputing) —
 * falls back to a fresh dailySnapshots() lookup (cheap: cached) otherwise.
 */
export async function gatherReportData({ ds, timezone, channelKinds, channelLabels, location, yesterdaySnapshot }) {
  const [y, m] = ds.split("-").map(Number);
  const dayOfMonth = Number(ds.split("-")[2]);

  const monthStartStr = `${y}-${String(m).padStart(2, "0")}-01`;
  let py = y,
    pm = m - 1;
  if (pm === 0) {
    pm = 12;
    py = y - 1;
  }
  const lastMonthStartStr = `${py}-${String(pm).padStart(2, "0")}-01`;
  const lastMonthSpanEndStr = `${py}-${String(pm).padStart(2, "0")}-${String(Math.min(dayOfMonth, daysInMonth(py, pm))).padStart(2, "0")}`;

  const dayStart = localDateToUtcMs(ds, timezone);
  const dayEnd = dayStartUtcMs(dayStart + 25 * 3600 * 1000, timezone);

  // Everything below is a synchronous, already-fast lookup (dailySnapshots
  // reads from the daily_snapshots cache for any completed day) except the
  // weather call, so only that one needs an actual await.
  const today = yesterdaySnapshot ?? dailySnapshots({ from: dayStart, to: dayEnd, channelKinds, channelLabels, timezone })[0];
  const dayBefore = dailySnapshots({
    from: localDateToUtcMs(dayBeforeStr(ds), timezone),
    to: dayStart,
    channelKinds,
    channelLabels,
    timezone,
  })[0];
  const thisMonthDays = dailySnapshots({
    from: localDateToUtcMs(monthStartStr, timezone),
    to: dayEnd,
    channelKinds,
    channelLabels,
    timezone,
  });
  const lastMonthDays = dailySnapshots({
    from: localDateToUtcMs(lastMonthStartStr, timezone),
    to: dayStartUtcMs(localDateToUtcMs(lastMonthSpanEndStr, timezone) + 25 * 3600 * 1000, timezone),
    channelKinds,
    channelLabels,
    timezone,
  });
  const warmest = location ? await getDayWarmest(dayStart, dayStart + 24 * 3600 * 1000) : null;

  // Last 7 days including yesterday, for the trend chart — a separate
  // fetch rather than slicing thisMonthDays, since a day-2-of-the-month
  // report needs days from the tail of last month too.
  const last7Days = dailySnapshots({
    from: localDateToUtcMs(daysBeforeStr(ds, 6), timezone),
    to: dayEnd,
    channelKinds,
    channelLabels,
    timezone,
  });

  const sumKwh = (days, field) => days.reduce((s, d) => s + (d[field] ?? 0), 0);
  const thisMonthSoFar = {
    producedKwh: sumKwh(thisMonthDays, "producedKwh"),
    gridImportKwh: sumKwh(thisMonthDays, "gridImportKwh"),
    gridExportKwh: sumKwh(thisMonthDays, "gridExportKwh"),
    netKwh: sumKwh(thisMonthDays, "gridImportKwh") - sumKwh(thisMonthDays, "gridExportKwh"),
    totalKwh: sumKwh(thisMonthDays, "totalKwh"),
    days: thisMonthDays.length,
  };
  const lastMonthSameSpan = {
    producedKwh: sumKwh(lastMonthDays, "producedKwh"),
    gridImportKwh: sumKwh(lastMonthDays, "gridImportKwh"),
    gridExportKwh: sumKwh(lastMonthDays, "gridExportKwh"),
    netKwh: sumKwh(lastMonthDays, "gridImportKwh") - sumKwh(lastMonthDays, "gridExportKwh"),
    totalKwh: sumKwh(lastMonthDays, "totalKwh"),
    days: lastMonthDays.length,
  };

  // Where yesterday's peak/peak-production rank against the rest of this
  // month so far — a cheap scan since every day here is already cached.
  const monthPeakConsumption = thisMonthDays.reduce(
    (best, d) => (d.peak && d.peak.totalPower > (best?.totalPower ?? -Infinity) ? d.peak : best),
    null
  );
  const monthPeakProduction = thisMonthDays.reduce(
    (best, d) => (d.peakProduction && d.peakProduction.solarPower > (best?.solarPower ?? -Infinity) ? d.peakProduction : best),
    null
  );

  // Both terms here come from the same night-aware computation
  // (computeSnapshotFromRows) — producedKwh already excludes nighttime
  // inverter standby draw misread through the solar clamp, so this can't
  // go negative the way naively pairing raw solar-channel export against
  // unfiltered "produced" could.
  const selfConsumedKwh = today ? Math.max(0, today.producedKwh - (today.gridExportKwh ?? 0)) : null;
  const selfConsumedPct = today && today.producedKwh > 0 ? round0((selfConsumedKwh / today.producedKwh) * 100) : null;

  // Cost estimate: this is deliberately anchored to the real electric
  // billing cycle (from Settings > Billing), not the calendar month —
  // SDGE's tier baseline is a per-cycle allowance, so calendar-month math
  // would mis-tier usage near a cycle boundary. "ds" is always the most
  // recently completed day, so the cycle-to-date window always ends there.
  const { start: cycleStartStr, end: cycleEndStr } = electricCycleRange(ds);
  const cycleFromMs = localDateToUtcMs(cycleStartStr, timezone);
  const cycleToMs = localDateToUtcMs(cycleEndStr, timezone);
  // nowMs pinned to the end of `ds`'s day — not the real current time — so
  // a test send for an old date can't pull in days that happened after the
  // date actually being reported.
  const cycleEstimate = estimatePeriodCost({ fromMs: cycleFromMs, toMs: cycleToMs, timezone, channelKinds, channelLabels, nowMs: dayEnd });
  // Yesterday's marginal cost = (cost through yesterday) − (cost through
  // the day before) — computed this way, not from yesterday's kWh alone,
  // so it correctly reflects whatever tier yesterday's usage actually fell
  // into given everything already used earlier in the cycle.
  const beforeYesterdayEstimate = estimatePeriodCost({
    fromMs: cycleFromMs,
    toMs: dayStart,
    timezone,
    channelKinds,
    channelLabels,
    nowMs: dayEnd,
    cycleDays: cycleEstimate.totalDays, // same whole-cycle Tier 1 boundary as the estimate above, so the difference is a true marginal cost
  });
  const todayNetKwh = today ? netKwhOf(today) : null;
  const yesterdayCost = today ? cycleEstimate.costToDate.totalCost - beforeYesterdayEstimate.costToDate.totalCost : null;

  return {
    ds,
    today,
    dayBefore,
    thisMonthSoFar,
    lastMonthSameSpan,
    last7Days,
    warmest,
    monthPeakConsumption,
    monthPeakProduction,
    exportedKwh: today?.gridExportKwh ?? null,
    selfConsumedPct,
    todayNetKwh,
    dayBeforeNetKwh: dayBefore ? netKwhOf(dayBefore) : null,
    billing: {
      cycleStartStr,
      cycleEndStr,
      cycleDaysElapsed: cycleEstimate.daysElapsed,
      cycleTotalDays: cycleEstimate.totalDays,
      cycleDaysRemaining: cycleEstimate.daysRemaining,
      cycleNetToDateKwh: cycleEstimate.netKwh,
      cycleCostToDate: cycleEstimate.costToDate,
      projectedCycleNetKwh: cycleEstimate.projectedNetKwh,
      cycleCostProjected: cycleEstimate.costProjected,
      yesterdayCost,
      rates: cycleEstimate.rates,
    },
    location,
    timezone,
  };
}

function statCard(label, value, unit, color, width) {
  return `
    <td style="padding:6px;width:${width ?? "25%"};" valign="top">
      <div style="background:#f7f7f5;border-radius:10px;padding:14px 10px;text-align:center;">
        <div style="font-size:10.5px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#8a8a86;margin-bottom:6px;">${label}</div>
        <div style="font-size:20px;font-weight:800;color:${color ?? "#1a1a18"};">${value}<span style="font-size:12px;font-weight:600;color:#8a8a86;"> ${unit}</span></div>
      </div>
    </td>`;
}

function factRow(icon, text) {
  return `
    <tr>
      <td style="padding:8px 0;border-top:1px solid #ececea;" valign="top">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:16px;padding-right:10px;vertical-align:top;">${icon}</td>
          <td style="font-size:13.5px;line-height:1.55;color:#3a3a37;">${text}</td>
        </tr></table>
      </td>
    </tr>`;
}

/**
 * Vertical bar chart of daily totalKwh, table-based (not SVG/canvas) so it
 * renders consistently across email clients that strip scripts and vary
 * wildly in CSS support — a `<td>` with an explicit pixel height is the one
 * "chart" technique that reliably works in Gmail, Apple Mail, and Outlook
 * alike. `days` ascending by date; the last one (today's report always
 * ends on yesterday) is highlighted as "yesterday."
 */
function trendChartHtml(days, timezone) {
  if (days.length < 2) return "";
  const maxBarPx = 64;
  const maxKwh = Math.max(1, ...days.map((d) => d.totalKwh));
  const dowFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone });
  const cells = days
    .map((d, i) => {
      const isLast = i === days.length - 1;
      const barPx = Math.max(3, Math.round((d.totalKwh / maxKwh) * maxBarPx));
      const color = isLast ? "#2a78d6" : "#c9ddf2";
      const [y, m, dd] = d.date.split("-").map(Number);
      const label = dowFmt.format(new Date(y, m - 1, dd));
      return `
        <td style="width:${Math.floor(100 / days.length)}%;text-align:center;vertical-align:bottom;padding:0 2px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>
            <td style="vertical-align:bottom;height:${maxBarPx}px;">
              <div style="width:22px;height:${barPx}px;background:${color};border-radius:3px 3px 0 0;margin:0 auto;"></div>
            </td>
          </tr></table>
          <div style="font-size:10px;color:${isLast ? "#2a78d6" : "#8a8a86"};font-weight:${isLast ? "700" : "400"};margin-top:5px;">${label}</div>
          <div style="font-size:9px;color:#b5b5b0;">${round1(d.totalKwh)}</div>
        </td>`;
    })
    .join("");
  return `
    <div style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#8a8a86;margin-bottom:10px;">Last ${days.length} days · total kWh</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>${cells}</tr></table>`;
}

/** Two-bar horizontal comparison — this month so far vs. the same span last month, by net usage (what's actually billed). Same table-based approach as trendChartHtml, for the same reason. */
function monthCompareChartHtml(thisMonth, lastMonth) {
  if (lastMonth.days === 0) return "";
  const maxKwh = Math.max(1, thisMonth.netKwh, lastMonth.netKwh);
  const barRow = (label, kwh, color) => `
    <tr>
      <td style="font-size:11.5px;color:#3a3a37;width:74px;padding:5px 8px 5px 0;white-space:nowrap;">${label}</td>
      <td style="padding:5px 0;">
        <div style="height:14px;border-radius:4px;background:${color};width:${Math.max(3, Math.round((kwh / maxKwh) * 100))}%;"></div>
      </td>
      <td style="font-size:11.5px;font-weight:700;color:#1a1a18;width:64px;padding:5px 0 5px 8px;text-align:right;white-space:nowrap;">${round1(kwh)} kWh</td>
    </tr>`;
  return `
    <div style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#8a8a86;margin-bottom:10px;">This month vs. last month (same ${thisMonth.days}-day span, net)</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      ${barRow("This month", thisMonth.netKwh, "#2a78d6")}
      ${barRow("Last month", lastMonth.netKwh, "#c9ddf2")}
    </table>`;
}

/**
 * "Tracking toward your bill" block — the email counterpart of the Daily
 * Snapshots page's animated CostGauge card (web/src/components/CostGauge.tsx).
 * Same underlying numbers and the same visual language (solid tier colors
 * for what's actually happened, a lighter shade for the projected
 * remainder, a boundary tick where Tier 1 gives way to Tier 2) — but built
 * from stacked `<td>` widths instead of flexbox/CSS transitions, since
 * that's the one "bar chart" technique that reliably survives Gmail, Apple
 * Mail, and Outlook alike (see trendChartHtml above). No animation in an
 * email, obviously — the "grow-in" is the web page's job.
 */
/**
 * Splits whichever segment in `segments` (ordered, {kwh, color}) straddles
 * cumulative position `atKwh` into two same-color pieces, so a boundary
 * marker can be drawn exactly there via a border on the first piece —
 * regardless of which segment the boundary actually falls in (already-past
 * it, still ahead in the projected portion, or out in the empty remainder).
 * Table cells can't be positioned independently of their neighbors the way
 * an absolutely-positioned tick can on the web page, so this is the email's
 * way of getting the same "tick lands at the real boundary" guarantee.
 */
function splitAtBoundary(segments, atKwh) {
  let acc = 0;
  let placed = false;
  const out = [];
  for (const seg of segments) {
    const segEnd = acc + seg.kwh;
    if (!placed && atKwh > acc + 1e-6 && atKwh < segEnd - 1e-6) {
      out.push({ kwh: atKwh - acc, color: seg.color, boundaryAfter: true });
      out.push({ kwh: segEnd - atKwh, color: seg.color });
      placed = true;
    } else {
      out.push({ ...seg, boundaryAfter: !placed && Math.abs(segEnd - atKwh) < 1e-6 });
      if (!placed && Math.abs(segEnd - atKwh) < 1e-6) placed = true;
    }
    acc = segEnd;
  }
  return { segments: out, placed };
}

export function costProgressBarHtml(billing) {
  const { cycleCostToDate, cycleCostProjected, cycleNetToDateKwh, projectedCycleNetKwh, rates } = billing;
  const fullBaselineKwh = cycleCostProjected.baselineKwh;
  const scaleMax = Math.max(projectedCycleNetKwh, fullBaselineKwh, 1) * 1.15;

  // Tier1/2 split for what's *actually happened* comes straight from
  // cycleCostToDate — the same billed-accurate numbers as the $ figures
  // and the caption below, computed against today's smaller prorated
  // allowance (cycleCostToDate.baselineKwh), not the full-cycle one.
  // Using the full-cycle baseline here too would let the bar show "still
  // in Tier 1" on a day the caption correctly says you've already crossed
  // into Tier 2 — the bar and the text have to agree.
  const actualKwh = Math.max(0, cycleNetToDateKwh);
  const actualTier1 = cycleCostToDate.tier1Kwh;
  const actualTier2 = cycleCostToDate.tier2Kwh;
  const projectedExtra = Math.max(0, projectedCycleNetKwh - actualKwh);
  const projectedExtraTier1 = Math.max(0, Math.min(fullBaselineKwh - actualTier1, projectedExtra));
  const projectedExtraTier2 = Math.max(0, projectedExtra - projectedExtraTier1);
  const filledKwh = actualTier1 + actualTier2 + projectedExtraTier1 + projectedExtraTier2;
  const remainderKwh = Math.max(0, scaleMax - filledKwh);

  const pct = (kwh) => (kwh / scaleMax) * 100;
  const boundaryPct = pct(fullBaselineKwh);

  const rawSegments = [
    { kwh: actualTier1, color: "#2a78d6" },
    { kwh: actualTier2, color: "#e0813f" },
    { kwh: projectedExtraTier1, color: "#a9c9ea" },
    { kwh: projectedExtraTier2, color: "#f0bd97" },
    { kwh: remainderKwh, color: "#ececea" },
  ];
  const { segments: splitSegments, placed: showBoundary } = splitAtBoundary(rawSegments, fullBaselineKwh);
  const segments = splitSegments.filter((s) => s.kwh > 0.01);

  const barCells = segments
    .map((s, i) => {
      const isFirst = i === 0;
      const isLast = i === segments.length - 1;
      const radius = `${isFirst ? "4px" : "0"} ${isLast ? "4px" : "0"} ${isLast ? "4px" : "0"} ${isFirst ? "4px" : "0"}`;
      const border = s.boundaryAfter ? "border-right:2px solid #1a1a18;" : "";
      return `<td style="height:16px;background:${s.color};width:${pct(s.kwh)}%;border-radius:${radius};${border}font-size:0;line-height:0;">&nbsp;</td>`;
    })
    .join("");

  const boundaryLabelRow =
    showBoundary && boundaryPct > 5 && boundaryPct < 95
      ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
           <td style="width:${boundaryPct}%;font-size:0;line-height:0;">&nbsp;</td>
           <td style="font-size:10px;font-weight:650;color:#8a8a86;white-space:nowrap;padding-left:4px;">Tier 1 → Tier 2</td>
         </tr></table>`
      : "";

  // "You are here": a red arrow above the bar at the net usage so far — the
  // point where the solid (actual) part ends and the striped projection
  // begins. Label sits to the left of the arrow when there's room, else to
  // its right.
  const hereKwh = Math.max(0, cycleNetToDateKwh);
  const herePct = Math.min(99, Math.max(0.5, pct(hereKwh)));
  const remaining = billing.cycleDaysRemaining;
  const hereLabel = `You are here · ${remaining} day${remaining === 1 ? "" : "s"} left in cycle`;
  const labelLeft = herePct >= 45;
  const hereRow = `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:2px;"><tr>
      <td align="right" style="width:${herePct}%;font-size:10.5px;font-weight:700;color:#d03b3b;white-space:nowrap;line-height:1;">${labelLeft ? `${hereLabel} ` : ""}<span style="font-size:14px;">&#9660;</span></td>
      <td style="font-size:10.5px;font-weight:700;color:#d03b3b;white-space:nowrap;padding-left:3px;line-height:1;">${labelLeft ? "" : hereLabel}</td>
    </tr></table>`;

  const netExportSoFar = cycleNetToDateKwh < 0;
  const leftToBoundary = fullBaselineKwh - hereKwh;
  const captionHtml = netExportSoFar
    ? `Running a net export so far this cycle (${round1(Math.abs(cycleNetToDateKwh))} kWh) — no tier usage yet, just the base service charge.`
    : `<strong>${round1(cycleCostToDate.tier1Kwh)}</strong> of your <strong>${round1(fullBaselineKwh)}</strong> kWh Tier 1 allowance for this cycle used so far${
        cycleCostToDate.tier2Kwh > 0
          ? ` — plus <strong>${round1(cycleCostToDate.tier2Kwh)}</strong> kWh already into Tier 2.`
          : ` (<strong>${round1(leftToBoundary)}</strong> kWh left before Tier 2).`
      } At this pace you'll reach <strong>${round1(projectedCycleNetKwh)}</strong> kWh net by cycle end${
        projectedCycleNetKwh > fullBaselineKwh ? `, about <strong>${round1(projectedCycleNetKwh - fullBaselineKwh)}</strong> kWh into Tier 2.` : ", staying within Tier 1."
      }`;

  return `
    ${hereRow}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>${barCells}</tr></table>
    <div style="margin-top:6px;">${boundaryLabelRow}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:10px;"><tr>
      <td style="font-size:11.5px;color:#3a3a37;padding-right:18px;"><span style="display:inline-block;width:8px;height:8px;background:#2a78d6;border-radius:2px;margin-right:6px;"></span>Tier 1 (${round0(rates.tier1RatePerKwh * 100)}¢/kWh)</td>
      <td style="font-size:11.5px;color:#3a3a37;padding-right:18px;"><span style="display:inline-block;width:8px;height:8px;background:#e0813f;border-radius:2px;margin-right:6px;"></span>Tier 2 (${round0(rates.tier2RatePerKwh * 100)}¢/kWh)</td>
      <td style="font-size:11.5px;color:#8a8a86;"><span style="display:inline-block;width:8px;height:8px;background:#a9c9ea;border-radius:2px;margin-right:6px;"></span>projected</td>
    </tr></table>
    <div style="font-size:12.5px;line-height:1.55;color:#3a3a37;margin-top:10px;">${captionHtml}</div>`;
}

/** Builds the email subject + HTML + plain-text fallback from gathered report data. */
export function buildDailyReport(data) {
  const {
    ds,
    today,
    dayBefore,
    thisMonthSoFar,
    lastMonthSameSpan,
    last7Days,
    warmest,
    monthPeakConsumption,
    monthPeakProduction,
    exportedKwh,
    selfConsumedPct,
    todayNetKwh,
    dayBeforeNetKwh,
    billing,
    location,
    timezone,
  } = data;

  const dateLabel = fmtDate(ds);
  const cityLabel = location ? `${location.city}, ${location.state}` : "";
  const subject = `Ohm Sweet Ohm — ${fmtDate(ds).replace(/, .*/, "")}: ${round1(todayNetKwh ?? today?.totalKwh ?? 0)} kWh net`;

  const facts = [];

  // Net — what pulled-from-grid minus pushed-back-to-grid actually comes
  // to — leads the facts list: it's what the bill is based on, unlike raw
  // consumption, which double-counts self-consumed and exported solar.
  if (todayNetKwh !== null) {
    const compareTxt =
      dayBeforeNetKwh !== null && dayBeforeNetKwh > 0
        ? `, ${todayNetKwh >= dayBeforeNetKwh ? "up" : "down"} from ${round1(dayBeforeNetKwh)} kWh the day before`
        : "";
    facts.push(
      factRow(
        todayNetKwh <= 0 ? "🔋" : dayBeforeNetKwh !== null && todayNetKwh >= dayBeforeNetKwh ? "📈" : "📉",
        `Net usage — pulled from the grid minus pushed back to it, what actually shows up on the bill — was <strong>${round1(todayNetKwh)} kWh</strong>${compareTxt}${todayNetKwh < 0 ? " (a net-export day)" : ""}.`
      )
    );
  }

  if (today?.biggestCircuit) {
    const share = today.totalKwh > 0 ? round0((today.biggestCircuit.kwh / today.totalKwh) * 100) : null;
    facts.push(
      factRow(
        "🔌",
        `<strong>${today.biggestCircuit.label}</strong> was the biggest single circuit — ${round1(today.biggestCircuit.kwh)} kWh${share !== null ? ` (~${share}% of the day's total)` : ""}.`
      )
    );
  }

  if (today?.peak) {
    const isMonthBest = monthPeakConsumption && today.peak.ts === monthPeakConsumption.ts;
    facts.push(
      factRow(
        isMonthBest ? "🏆" : "⚡",
        `Peak household draw was <strong>${round0(today.peak.totalPower).toLocaleString()} W</strong> at ${fmtTime(today.peak.ts, timezone)}${today.peak.gridPower > 0 ? ` (${round0(today.peak.gridPower).toLocaleString()} W from the grid` : " (fully covered by solar"}${today.peak.solarPower > 0 ? `, ${round0(today.peak.solarPower).toLocaleString()} W solar)` : ")"}${isMonthBest ? " — the highest so far this month." : "."}`
      )
    );
  }

  if (today?.peakProduction?.solarPower > 0) {
    const isMonthBest = monthPeakProduction && today.peakProduction.ts === monthPeakProduction.ts;
    facts.push(
      factRow(
        isMonthBest ? "🌞" : "☀️",
        `Solar peaked at <strong>${round0(today.peakProduction.solarPower).toLocaleString()} W</strong> around ${fmtTime(today.peakProduction.ts, timezone)}${isMonthBest ? " — the best output this month." : "."}`
      )
    );
  }

  if (selfConsumedPct !== null) {
    facts.push(
      factRow(
        "♻️",
        `<strong>${selfConsumedPct}%</strong> of yesterday's solar was used directly in the house${exportedKwh ? `; ${round1(exportedKwh)} kWh went back to the grid.` : "."}`
      )
    );
  }

  if (warmest) {
    facts.push(factRow("🌡️", `Warmest moment was <strong>${round0(warmest.tempF)}°F</strong> around ${fmtTime(warmest.ts, timezone)}.`));
  }

  const monthChange = pctChange(thisMonthSoFar.netKwh, lastMonthSameSpan.netKwh);
  const monthFactHtml =
    lastMonthSameSpan.days > 0
      ? `Through day ${thisMonthSoFar.days} of the month, net usage is <strong>${round1(thisMonthSoFar.netKwh)} kWh</strong>${
          monthChange !== null
            ? `, ${monthChange >= 0 ? "up" : "down"} <strong>${Math.abs(round0(monthChange))}%</strong> from the same ${lastMonthSameSpan.days}-day stretch last month (${round1(lastMonthSameSpan.netKwh)} kWh).`
            : "."
        }`
      : `Through day ${thisMonthSoFar.days} of the month, net usage is <strong>${round1(thisMonthSoFar.netKwh)} kWh</strong> — not enough history from last month yet to compare.`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;">
<div style="background:#f0f0ee;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6e6e3;">
    <tr>
      <td style="background:#2a78d6;padding:22px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle;padding-right:10px;">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12 L16 4 L26 12"/><path d="M9 26.5 L6.5 27.5 M9 26.5 L9 17.5 A7 7 0 0 1 23 17.5 L23 26.5 M23 26.5 L25.5 27.5"/></svg>
          </td>
          <td style="vertical-align:middle;">
            <div style="color:#ffffff;font-size:18px;font-weight:800;">Ohm Sweet Ohm</div>
            <div style="color:#cfe1f7;font-size:12.5px;">Daily recap — ${dateLabel}${cityLabel ? ` · ${cityLabel}` : ""}</div>
          </td>
        </tr></table>
      </td>
    </tr>

    <tr>
      <td style="padding:20px 20px 4px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
          ${statCard("Produced", round1(today?.producedKwh ?? 0), "kWh", "#1baf7a")}
          ${statCard("Pulled from grid", round1(today?.gridImportKwh ?? 0), "kWh", "#2a78d6")}
          ${statCard("Net (billed)", round1(todayNetKwh ?? 0), "kWh", todayNetKwh !== null && todayNetKwh < 0 ? "#1baf7a" : "#1a1a18")}
          ${statCard("Total", round1(today?.totalKwh ?? 0), "kWh", "#1a1a18")}
        </tr></table>
      </td>
    </tr>

    ${
      last7Days.length >= 2
        ? `<tr>
      <td style="padding:0 20px 20px;">
        <div style="background:#f7f7f5;border-radius:10px;padding:14px 16px;">
          ${trendChartHtml(last7Days, timezone)}
        </div>
      </td>
    </tr>`
        : ""
    }

    <tr>
      <td style="padding:8px 20px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          ${facts.join("")}
        </table>
      </td>
    </tr>

    <tr>
      <td style="padding:0 20px 22px;">
        <div style="background:#f7f7f5;border-radius:10px;padding:14px 16px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#8a8a86;margin-bottom:6px;">This month so far</div>
          <div style="font-size:13.5px;line-height:1.55;color:#3a3a37;margin-bottom:${lastMonthSameSpan.days > 0 ? "14px" : "0"};">${monthFactHtml}</div>
          ${monthCompareChartHtml(thisMonthSoFar, lastMonthSameSpan)}
        </div>
      </td>
    </tr>

    ${
      billing
        ? `<tr>
      <td style="padding:0 20px 22px;">
        <div style="background:#f7f7f5;border-radius:10px;padding:16px 18px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#8a8a86;">Tracking toward your bill</td>
            <td align="right" style="font-size:11px;color:#8a8a86;font-weight:600;white-space:nowrap;">${fmtShortDate(billing.cycleStartStr)} – ${fmtShortDate(dayBeforeStr(billing.cycleEndStr))} · day ${billing.cycleDaysElapsed} of ${billing.cycleTotalDays} · ${billing.cycleDaysRemaining} left</td>
          </tr></table>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:10px;"><tr>
            <td style="padding-right:30px;" valign="top">
              <div style="font-size:30px;font-weight:800;color:#2a78d6;line-height:1;">$${billing.cycleCostToDate.totalCost.toFixed(2)}</div>
              <div style="font-size:11px;color:#8a8a86;font-weight:600;margin-top:4px;">estimated so far this cycle</div>
            </td>
            <td valign="top">
              <div style="font-size:20px;font-weight:700;color:#3a3a37;line-height:1;">$${billing.cycleCostProjected.totalCost.toFixed(2)}</div>
              <div style="font-size:11px;color:#8a8a86;font-weight:600;margin-top:4px;">projected by cycle end</div>
            </td>
          </tr></table>
          <div style="margin:16px 0 0;">
            ${costProgressBarHtml(billing)}
          </div>
          <div style="font-size:10.5px;line-height:1.5;color:#a3a39e;margin-top:10px;">Yesterday's cost: ${billing.yesterdayCost !== null ? `$${billing.yesterdayCost.toFixed(2)}` : "n/a"}. Estimate only — ${billing.rates.season} tier rates${billing.rates.verified ? "" : " (carried over from summer — no winter bill on file yet)"}, doesn't include the twice-yearly Climate Credit or other one-off adjustments.</div>
        </div>
      </td>
    </tr>`
        : ""
    }

    <tr>
      <td style="padding:16px 20px 22px;border-top:1px solid #ececea;">
        <a href="https://meter.langecornu.com" style="display:inline-block;background:#2a78d6;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700;font-size:13.5px;">Open the dashboard →</a>
        <div style="margin-top:14px;font-size:11.5px;color:#a3a39e;">You're getting this because daily email reports are on for Ohm Sweet Ohm. Turn them off any time in Settings.</div>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;

  const text = [
    `Ohm Sweet Ohm — ${dateLabel}`,
    ``,
    `Produced: ${round1(today?.producedKwh ?? 0)} kWh`,
    `Pulled from grid: ${round1(today?.gridImportKwh ?? 0)} kWh`,
    `Net (billed): ${round1(todayNetKwh ?? 0)} kWh`,
    `Total: ${round1(today?.totalKwh ?? 0)} kWh`,
    ``,
    monthFactHtml.replace(/<[^>]+>/g, ""),
    ``,
    ...(billing
      ? [
          `This billing cycle (${billing.cycleStartStr} to ${ds}, day ${billing.cycleDaysElapsed} of ${billing.cycleTotalDays}):`,
          `  Yesterday's cost: ${billing.yesterdayCost !== null ? `$${billing.yesterdayCost.toFixed(2)}` : "n/a"}`,
          `  Cost so far: $${billing.cycleCostToDate.totalCost.toFixed(2)} (${round1(billing.cycleNetToDateKwh)} kWh net — ${round1(billing.cycleCostToDate.tier1Kwh)} kWh Tier 1, ${round1(billing.cycleCostToDate.tier2Kwh)} kWh Tier 2)`,
          `  Projected full-cycle cost: $${billing.cycleCostProjected.totalCost.toFixed(2)} (${round1(billing.projectedCycleNetKwh)} kWh net, ${round1(billing.cycleCostProjected.baselineKwh)} kWh full-cycle Tier 1 allowance)`,
          `  Estimate only, ${billing.rates.season} rates${billing.rates.verified ? "" : " carried over from summer"} — not an official bill.`,
          ``,
        ]
      : []),
    `https://meter.langecornu.com`,
  ].join("\n");

  return { subject, html, text };
}

/**
 * Sends the daily report for local calendar day `ds` if daily emails are
 * enabled. `yesterdaySnapshot` lets the caller (maybeRollupYesterday in
 * index.js, right after persisting that day) hand over the snapshot it
 * already computed instead of this doing a redundant lookup.
 */
export async function maybeSendDailyReport(ds, { channelKinds, channelLabels, timezone, location, yesterdaySnapshot }) {
  // Temporary diagnostic (see mail.js's sendRaw) for the double daily-email
  // issue — pid + whether a pre-computed snapshot was handed in + its
  // sample count tells us whether this ran twice, and whether one run used
  // incomplete data.
  console.log(
    `[dailyEmail] maybeSendDailyReport pid=${process.pid} ds=${ds} hadYesterdaySnapshot=${!!yesterdaySnapshot} yesterdaySnapshotSamples=${yesterdaySnapshot?.sampleCount ?? "n/a"} at ${new Date().toISOString()}`
  );
  const settings = getDailyEmailSettings();
  if (!settings.enabled || !settings.address) return;
  const data = await gatherReportData({ ds, timezone, channelKinds, channelLabels, location, yesterdaySnapshot });
  console.log(
    `[dailyEmail] maybeSendDailyReport pid=${process.pid} ds=${ds} computed today.sampleCount=${data.today?.sampleCount ?? "none"} today.totalKwh=${data.today?.totalKwh ?? "none"}`
  );
  if (!data.today || data.today.sampleCount === 0) return; // nothing to report
  const { subject, html, text } = buildDailyReport(data);
  await sendDailyReportEmail(settings.address, subject, html, text);
}

/** Sends a test report right now, for whatever the most recently completed day is, ignoring the enabled toggle (but still using the configured address). Used by the "Send test email" button in Settings. */
export async function sendTestDailyReport(ds, { channelKinds, channelLabels, timezone, location }) {
  const settings = getDailyEmailSettings();
  if (!settings.address) throw new Error("no address configured");
  const data = await gatherReportData({ ds, timezone, channelKinds, channelLabels, location });
  if (!data.today || data.today.sampleCount === 0) throw new Error(`no data for ${ds} yet`);
  const { subject, html, text } = buildDailyReport(data);
  await sendDailyReportEmail(settings.address, `[Test] ${subject}`, html, text);
}
