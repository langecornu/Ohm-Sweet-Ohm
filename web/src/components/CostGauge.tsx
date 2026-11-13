import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CostEstimate } from "../types";

function fmtUsd(n: number) {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtKwh(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function fmtAgo(computedAt: number, nowMs: number) {
  const mins = Math.round((nowMs - computedAt) / 60_000);
  if (mins <= 0) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
}

/** Ticks once a minute so the "refreshed X ago" label stays current without needing a new fetch. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Eases a number from 0 up to `target` over `durationMs` whenever `target` changes — the "$ ticking up" effect. */
function useCountUp(target: number, durationMs = 900) {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const to = target;
    let raf = 0;
    const start = performance.now();
    function tick(now: number) {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setValue(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

/** Goes 0 → `target` on mount/whenever it changes — a double-rAF so the browser paints the 0 frame before a CSS transition on the value kicks in. */
function useGrown(target: number) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    setValue(0);
    let raf1 = 0,
      raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setValue(target));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [target]);
  return value;
}

/** A bar segment that grows from 0% to `targetPct` on mount/whenever it changes. */
function GrowBar({ targetPct, style, className }: { targetPct: number; style?: CSSProperties; className?: string }) {
  const pct = useGrown(targetPct);
  return (
    <div
      className={className}
      style={{
        ...style,
        width: `${Math.max(0, Math.min(100, pct))}%`,
        transition: "width 1.1s cubic-bezier(.16,1,.3,1)",
      }}
    />
  );
}

export default function CostGauge({
  estimate,
  loading,
  cycleLabel,
}: {
  estimate: CostEstimate | null;
  loading: boolean;
  cycleLabel: string;
}) {
  const now = useNow();
  const costSoFar = useCountUp(estimate?.costToDate.totalCost ?? 0);
  const costProjected = useCountUp(estimate?.costProjected.totalCost ?? 0, 1100);
  const hereTargetPct = estimate
    ? Math.min(99, Math.max(0.5, (Math.max(0, estimate.netKwh) / (Math.max(estimate.projectedNetKwh, estimate.costProjected.baselineKwh, 1) * 1.15)) * 100))
    : 0;
  const herePct = useGrown(hereTargetPct);

  if (loading && !estimate) {
    return (
      <div className="card cost-gauge">
        <div className="skeleton" style={{ height: 14, width: 160, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 40, width: 140, marginBottom: 18 }} />
        <div className="skeleton" style={{ height: 22, width: "100%", borderRadius: 11 }} />
      </div>
    );
  }
  if (!estimate) return null;

  const { costToDate, costProjected: proj, netKwh, projectedNetKwh, daysElapsed, totalDays, daysRemaining, rates } = estimate;
  const fullBaselineKwh = proj.baselineKwh;
  const scaleMax = Math.max(projectedNetKwh, fullBaselineKwh, 1) * 1.15;

  const actualKwh = Math.max(0, netKwh);
  // Tier1/2 split for what's *actually happened* comes straight from
  // costToDate — the same billed-accurate numbers as the $ figures and the
  // caption below. Its boundary (costToDate.baselineKwh) is the whole
  // cycle's Tier 1 allowance, the same one the tick marks, because SDGE
  // tiers the cycle's cumulative usage rather than prorating by day.
  const actualTier1 = costToDate.tier1Kwh;
  const actualTier2 = costToDate.tier2Kwh;
  const projectedExtra = Math.max(0, projectedNetKwh - actualKwh);
  const projectedExtraTier1 = Math.max(0, Math.min(fullBaselineKwh - actualTier1, projectedExtra));
  const projectedExtraTier2 = Math.max(0, projectedExtra - projectedExtraTier1);

  const boundaryPct = (fullBaselineKwh / scaleMax) * 100;
  const inTier2Now = actualTier2 > 0;
  const netExportSoFar = netKwh < 0;

  return (
    <div className="card cost-gauge">
      <div className="cost-gauge-head">
        <h2 style={{ margin: 0 }}>Tracking toward your bill</h2>
        <span className="cost-gauge-cycle" title={new Date(estimate.computedAt).toLocaleString()}>
          {cycleLabel} · day {daysElapsed} of {totalDays} · {daysRemaining} left
          <br />
          refreshed {fmtAgo(estimate.computedAt, now)}
        </span>
      </div>

      <div className="cost-gauge-numbers">
        <div className="cost-gauge-main">
          <div className="cost-gauge-main-value">{fmtUsd(costSoFar)}</div>
          <div className="cost-gauge-main-label">estimated so far this cycle</div>
        </div>
        <div className="cost-gauge-projected">
          <div className="cost-gauge-projected-value">{fmtUsd(costProjected)}</div>
          <div className="cost-gauge-main-label">projected by cycle end</div>
        </div>
      </div>

      <div className="cost-gauge-bar-wrap">
        <div className="cost-gauge-here" style={{ left: `${herePct}%` }}>
          <span className={`cost-gauge-here-label ${hereTargetPct >= 45 ? "left" : "right"}`}>
            You are here · {daysRemaining} day{daysRemaining === 1 ? "" : "s"} left in cycle
          </span>
          <span className="cost-gauge-here-arrow">▼</span>
        </div>
        <div className="cost-gauge-bar-track">
          <GrowBar targetPct={(actualTier1 / scaleMax) * 100} className="cost-gauge-seg cost-gauge-seg-tier1" />
          <GrowBar
            targetPct={(actualTier2 / scaleMax) * 100}
            className={`cost-gauge-seg cost-gauge-seg-tier2 ${inTier2Now ? "pulse" : ""}`}
          />
          <GrowBar targetPct={(projectedExtraTier1 / scaleMax) * 100} className="cost-gauge-seg cost-gauge-seg-tier1-projected" />
          <GrowBar targetPct={(projectedExtraTier2 / scaleMax) * 100} className="cost-gauge-seg cost-gauge-seg-tier2-projected" />
          <div className="cost-gauge-boundary" style={{ left: `${Math.min(99, boundaryPct)}%` }} />
        </div>
        <div className="cost-gauge-boundary-label" style={{ left: `${Math.min(92, Math.max(6, boundaryPct))}%` }}>
          Tier 1 → Tier 2
        </div>
      </div>

      <div className="cost-gauge-legend">
        <span className="cost-gauge-legend-item">
          <i className="cost-gauge-dot cost-gauge-seg-tier1" /> Tier 1 ({Math.round(rates.tier1RatePerKwh * 100)}¢/kWh)
        </span>
        <span className="cost-gauge-legend-item">
          <i className="cost-gauge-dot cost-gauge-seg-tier2" /> Tier 2 ({Math.round(rates.tier2RatePerKwh * 100)}¢/kWh)
        </span>
        <span className="cost-gauge-legend-item muted">
          <i className="cost-gauge-dot cost-gauge-seg-tier1-projected" /> projected
        </span>
      </div>

      <div className="cost-gauge-caption">
        {netExportSoFar ? (
          <>
            Running a net export so far this cycle ({fmtKwh(Math.abs(netKwh))} kWh) — no tier usage yet, just the base service
            charge.
          </>
        ) : (
          <>
            <strong>{fmtKwh(costToDate.tier1Kwh)}</strong> of your <strong>{fmtKwh(fullBaselineKwh)}</strong> kWh Tier 1
            allowance for this cycle used so far
            {costToDate.tier2Kwh > 0 ? (
              <>
                {" "}
                — plus <strong>{fmtKwh(costToDate.tier2Kwh)}</strong> kWh already into Tier 2.
              </>
            ) : (
              <>
                {" "}
                (<strong>{fmtKwh(Math.max(0, fullBaselineKwh - actualKwh))}</strong> kWh left before Tier 2).
              </>
            )}
          </>
        )}{" "}
        At this pace you'll reach <strong>{fmtKwh(projectedNetKwh)}</strong> kWh net by cycle end
        {projectedNetKwh > fullBaselineKwh ? (
          <>
            , about <strong>{fmtKwh(projectedNetKwh - fullBaselineKwh)}</strong> kWh into Tier 2.
          </>
        ) : (
          ", staying within Tier 1."
        )}
      </div>

      <div className="cost-gauge-footnote">
        Estimate only — {rates.season} tier rates{rates.verified ? "" : " (carried over from summer, no winter bill on file yet)"},
        doesn't include the twice-yearly Climate Credit or other one-off adjustments.
      </div>
    </div>
  );
}
