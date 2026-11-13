import type { TodaySnapshot } from "../types";

function fmt(n: number, digits = 1) {
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function SnapshotSkeletonTiles({ count = 6 }: { count?: number }) {
  return (
    <div className="hero-row">
      {Array.from({ length: count }).map((_, i) => (
        <div className="stat-tile" key={i}>
          <div className="skeleton" style={{ height: 10, width: "55%", marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 28, width: "75%" }} />
        </div>
      ))}
    </div>
  );
}

/**
 * The six-tile snapshot layout — produced, pulled from grid, total, warmest,
 * biggest circuit, peak consumption. Shared by the Live tab's "Today's
 * snapshot" card and the Daily Snapshots history page's day detail, so both
 * always show literally the same fields the same way.
 */
export default function SnapshotTiles({ snapshot }: { snapshot: TodaySnapshot }) {
  return (
    <div className="hero-row">
      <div className="stat-tile">
        <div className="label">Produced</div>
        <div className="value" style={{ color: "var(--series-3)" }}>
          {fmt(snapshot.producedKwh, 2)}
          <span className="unit">kWh</span>
        </div>
      </div>
      <div className="stat-tile">
        <div className="label">Pulled from grid</div>
        <div className="value">
          {fmt(snapshot.gridImportKwh, 2)}
          <span className="unit">kWh</span>
        </div>
      </div>
      <div className="stat-tile">
        <div className="label">Total consumption</div>
        <div className="value">
          {fmt(snapshot.totalKwh, 2)}
          <span className="unit">kWh</span>
        </div>
        <div className="sub">produced + pulled from grid</div>
      </div>
      <div className="stat-tile">
        <div className="label">Warmest</div>
        {snapshot.warmest ? (
          <>
            <div className="value" style={{ color: "var(--series-4)" }}>
              {fmt(snapshot.warmest.tempF, 0)}
              <span className="unit">°F</span>
            </div>
            <div className="sub">at {timeOf(snapshot.warmest.ts)}</div>
          </>
        ) : (
          <>
            <div className="value">—</div>
            <div className="sub">Set a zip in Settings to unlock this</div>
          </>
        )}
      </div>
      <div className="stat-tile">
        <div className="label">Biggest circuit</div>
        {snapshot.biggestCircuit ? (
          <>
            <div className="value">
              {fmt(snapshot.biggestCircuit.kwh, 2)}
              <span className="unit">kWh</span>
            </div>
            <div className="sub">{snapshot.biggestCircuit.label}</div>
          </>
        ) : (
          <div className="value">—</div>
        )}
      </div>
      <div className="stat-tile">
        <div className="label">Peak consumption</div>
        {snapshot.peak ? (
          <>
            <div className="value">
              {fmt(snapshot.peak.totalPower, 0)}
              <span className="unit">W</span>
            </div>
            <div className="sub">
              at {timeOf(snapshot.peak.ts)} — {fmt(snapshot.peak.gridPower, 0)}W grid, {fmt(snapshot.peak.solarPower, 0)}W solar
            </div>
          </>
        ) : (
          <div className="value">—</div>
        )}
      </div>
    </div>
  );
}
