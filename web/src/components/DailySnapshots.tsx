import { memo, useEffect, useMemo, useState } from "react";
import { fetchBillingSettings, fetchCostEstimate, fetchDailySnapshots } from "../api";
import type { BillingSettings, CostEstimate, DailyTotal } from "../types";
import CostGauge from "./CostGauge";

type PeriodMode = "calendar" | "solar" | "electric";

const MODE_LABEL: Record<PeriodMode, string> = { calendar: "Calendar month", solar: "Solar billing", electric: "Electric billing" };

function addMonths(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}
function addDays(d: Date, n: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}
function fmtKwh(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtW(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
// The meter reports every ~2 seconds, so a full day is ~43,200 readings. A
// completed day with under 90% of that has real gaps (server or meter
// offline) — its totals are interpolated across the holes, so they're
// flagged rather than presented as if complete. (Today is still filling up,
// so it's never flagged.)
const EXPECTED_SAMPLES_PER_DAY = 43_200;
const PARTIAL_BELOW = 0.9;
function coveragePct(d: { sampleCount: number }) {
  return Math.round((d.sampleCount / EXPECTED_SAMPLES_PER_DAY) * 100);
}
function dateLabel(dateStr: string) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function dayOfMonthRange(refDate: Date, cycleDay: number) {
  let start = new Date(refDate.getFullYear(), refDate.getMonth(), Math.min(cycleDay, 28));
  if (refDate.getDate() < cycleDay) start = addMonths(start, -1);
  return { start, end: addMonths(start, 1) };
}

/** Electric cycle containing `refDate` — mirrors server/src/billing.js's
 * electricCycleRange() (the email and the cost-tracker cache use that one,
 * so the two must agree for the gauge to hit its cached value): known SDGE
 * read dates define each cycle as (previous read, this read]; past the last
 * known read, cycles repeat on its day-of-month. */
function electricRange(refDate: Date, billing: BillingSettings) {
  const reads = [...(billing.electricReadDates ?? [])].sort().map((r) => new Date(`${r}T00:00:00`));
  if (reads.length === 0) return dayOfMonthRange(refDate, billing.electricBillingDay);
  const day = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  const i = reads.findIndex((r) => day <= r);
  if (i > 0) return { start: addDays(reads[i - 1], 1), end: addDays(reads[i], 1) };
  if (i === 0) {
    const end = addDays(reads[0], 1);
    return { start: dayOfMonthRange(day, end.getDate()).start, end };
  }
  const lastEnd = addDays(reads[reads.length - 1], 1);
  const r = dayOfMonthRange(day, lastEnd.getDate());
  return { start: r.start < lastEnd ? lastEnd : r.start, end: r.end };
}

/** The [start, end) range for `mode`, containing `refDate`. `end` is exclusive. */
function periodRangeFor(mode: PeriodMode, refDate: Date, billing: BillingSettings) {
  if (mode === "calendar") {
    const start = new Date(refDate.getFullYear(), refDate.getMonth(), 1);
    return { start, end: addMonths(start, 1) };
  }
  return mode === "solar" ? dayOfMonthRange(refDate, billing.solarBillingDay) : electricRange(refDate, billing);
}

function rangeLabel(mode: PeriodMode, start: Date, end: Date) {
  if (mode === "calendar") return start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const last = addDays(end, -1);
  const sameYear = start.getFullYear() === last.getFullYear();
  const startFmt = start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
  const endFmt = last.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${startFmt} – ${endFmt}`;
}

function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: 8 }).map((__, j) => (
            <td key={j}>
              <div className="skeleton" style={{ height: 12, width: j === 0 ? "70%" : "85%" }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// Wrapped in memo() (see AboutPage.tsx) — takes no props, so this bails
// App's every-~2s live-socket re-render out of this whole subtree; its own
// fetches/setState still re-render it normally.
function DailySnapshots() {
  const [billing, setBilling] = useState<BillingSettings>({ solarBillingDay: 1, electricBillingDay: 1, electricReadDates: [] });
  // Defaults to the real electric billing cycle, not the calendar month —
  // that's the period your SDGE tiers and $ tracking below actually run
  // on, so it's the more useful "what am I looking at" default.
  const [mode, setMode] = useState<PeriodMode>("electric");
  const [refDate, setRefDate] = useState(() => new Date());

  const [days, setDays] = useState<DailyTotal[] | null>(null);
  const [loading, setLoading] = useState(false);

  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [costLoading, setCostLoading] = useState(false);

  useEffect(() => {
    fetchBillingSettings()
      .then(setBilling)
      .catch(() => {});
  }, []);

  const { start, end } = useMemo(
    () => periodRangeFor(mode, refDate, billing),
    [mode, refDate, billing]
  );

  const startMs = start.getTime();
  const endMs = end.getTime();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchDailySnapshots(startMs, endMs)
      .then((r) => !cancelled && setDays(r.days))
      .catch(() => !cancelled && setDays([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // `start`/`end` are new Date *objects* every time periodRangeFor()'s
    // useMemo above recomputes — including when `billing` resolves to the
    // exact same values it already had (its own object reference still
    // changes) — so depending on them directly re-fired this fetch a
    // second time on every load even though the actual range hadn't
    // changed. Depending on their primitive timestamps instead means this
    // only re-runs when the range's real value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMs, endMs]);

  // Cost/tier tracking is only meaningful against the real electric
  // billing cycle — SDGE's tiers reset per that cycle, not per calendar
  // month or the solar company's own cycle — so this only fetches (and
  // the gauge only renders) in "electric" mode.
  useEffect(() => {
    if (mode !== "electric") {
      setCostEstimate(null);
      return;
    }
    let cancelled = false;
    setCostLoading(true);
    fetchCostEstimate(startMs, endMs)
      .then((r) => !cancelled && setCostEstimate(r))
      .catch(() => !cancelled && setCostEstimate(null))
      .finally(() => !cancelled && setCostLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, startMs, endMs]);

  function switchMode(next: PeriodMode) {
    setMode(next);
    setRefDate(new Date());
  }
  function prevPeriod() {
    setRefDate(addDays(start, -1));
  }
  function nextPeriod() {
    setRefDate(end);
  }

  const sortedDays = useMemo(() => (days ? [...days].sort((a, b) => (a.date < b.date ? 1 : -1)) : null), [days]);

  const todayStr = new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
  const isPartial = (d: DailyTotal) => d.date !== todayStr && d.sampleCount < EXPECTED_SAMPLES_PER_DAY * PARTIAL_BELOW;
  const partialCount = (days ?? []).filter(isPartial).length;

  const totals = useMemo(() => {
    const list = days ?? [];
    const grid = list.reduce((s, d) => s + d.gridImportKwh, 0);
    const exported = list.reduce((s, d) => s + d.gridExportKwh, 0);
    return {
      produced: list.reduce((s, d) => s + d.producedKwh, 0),
      grid,
      exported,
      net: grid - exported,
      total: list.reduce((s, d) => s + d.totalKwh, 0),
      daysWithData: list.length,
    };
  }, [days]);

  return (
    <div className="card">
      <div className="range-bar" style={{ marginBottom: 14 }}>
        {(["calendar", "solar", "electric"] as PeriodMode[]).map((m) => (
          <button key={m} className={`range-btn ${mode === m ? "active" : ""}`} onClick={() => switchMode(m)}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <button className="range-btn" onClick={prevPeriod} aria-label="Previous period">
          ‹
        </button>
        <h2 style={{ margin: 0, textTransform: "none", fontSize: 15 }}>{rangeLabel(mode, start, end)}</h2>
        <button className="range-btn" onClick={nextPeriod} aria-label="Next period">
          ›
        </button>
      </div>

      {mode === "electric" ? (
        <div style={{ marginBottom: 20 }}>
          <CostGauge estimate={costEstimate} loading={costLoading} cycleLabel={rangeLabel(mode, start, end)} />
        </div>
      ) : (
        <div className="empty-state" style={{ marginBottom: 20, padding: "14px 16px", textAlign: "left" }}>
          $ tracking toward your SDGE tiers is shown for <strong>Electric billing</strong> periods — switch to that tab above to
          see it.
        </div>
      )}

      <div className="table-wrap">
        <table className="snapshot-table">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Produced</th>
              <th className="num">Pulled from grid</th>
              <th className="num" title="Pulled from grid minus pushed back to it — the same net-metering figure your utility bill is actually based on">
                Net
              </th>
              <th className="num">Total</th>
              <th>Warmest</th>
              <th>Biggest circuit</th>
              <th>Peak consumption</th>
            </tr>
          </thead>
          <tbody>
            {loading && !sortedDays ? (
              <SkeletonRows />
            ) : sortedDays && sortedDays.length > 0 ? (
              sortedDays.map((d) => (
                <tr key={d.date}>
                  <td className="date-cell">
                    {dateLabel(d.date)}
                    {isPartial(d) && (
                      <span
                        className="partial-badge"
                        title={`Only ${coveragePct(d)}% of this day's readings were recorded (the meter or server was offline part of the day), so its totals are estimates interpolated across the gaps.`}
                      >
                        partial · {coveragePct(d)}%
                      </span>
                    )}
                  </td>
                  <td className="num" style={{ color: "var(--series-3)" }}>
                    {fmtKwh(d.producedKwh)} kWh
                  </td>
                  <td className="num">{fmtKwh(d.gridImportKwh)} kWh</td>
                  <td className="num" style={d.gridImportKwh - d.gridExportKwh < 0 ? { color: "var(--series-3)" } : undefined}>
                    {fmtKwh(d.gridImportKwh - d.gridExportKwh)} kWh
                  </td>
                  <td className="num">{fmtKwh(d.totalKwh)} kWh</td>
                  <td>
                    {d.warmest ? (
                      <>
                        <div>
                          {fmtW(d.warmest.tempF)}°F<span className="table-sub"> at {timeOf(d.warmest.ts)}</span>
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {d.biggestCircuit ? (
                      <>
                        {fmtKwh(d.biggestCircuit.kwh)} kWh
                        <div className="table-sub">{d.biggestCircuit.label}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {d.peak ? (
                      <>
                        {fmtW(d.peak.totalPower)} W
                        <div className="table-sub">
                          {timeOf(d.peak.ts)} · {fmtW(d.peak.gridPower)}W grid, {fmtW(d.peak.solarPower)}W solar
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8}>
                  <div className="empty-state">No data for this period.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {partialCount > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>
          {partialCount} day{partialCount === 1 ? "" : "s"} marked <span className="partial-badge">partial</span> had gaps in the recording
          (meter or server offline), so those totals are incomplete estimates.
        </div>
      )}

      {!loading && days && days.length > 0 && (
        <div className="hero-row" style={{ marginTop: 16 }}>
          <div className="stat-tile">
            <div className="label">Total produced</div>
            <div className="value" style={{ color: "var(--series-3)" }}>
              {fmtKwh(totals.produced)}
              <span className="unit">kWh</span>
            </div>
            <div className="sub">
              {totals.daysWithData} day{totals.daysWithData === 1 ? "" : "s"} in this period
            </div>
          </div>
          <div className="stat-tile">
            <div className="label">Total pulled from grid</div>
            <div className="value">
              {fmtKwh(totals.grid)}
              <span className="unit">kWh</span>
            </div>
          </div>
          <div className="stat-tile">
            <div className="label">Total net</div>
            <div className="value" style={totals.net < 0 ? { color: "var(--series-3)" } : undefined}>
              {fmtKwh(totals.net)}
              <span className="unit">kWh</span>
            </div>
            <div className="sub">pulled from grid − pushed back to it — this is what your utility bill is actually based on</div>
          </div>
          <div className="stat-tile">
            <div className="label">Total consumption</div>
            <div className="value">
              {fmtKwh(totals.total)}
              <span className="unit">kWh</span>
            </div>
            <div className="sub">produced + pulled from grid — your household's real usage, before solar export is netted out</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(DailySnapshots);
