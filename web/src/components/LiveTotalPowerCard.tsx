import { useEffect, useState } from "react";
import LiveChart from "./LiveChart";
import { fetchHistory } from "../api";
import type { RollingPoint } from "../useLiveSocket";
import type { ChannelMeta } from "../types";

type Span = "10m" | "1h" | "12h" | "24h";

const SPANS: { key: Span; label: string; ms: number }[] = [
  { key: "10m", label: "10 min", ms: 10 * 60 * 1000 },
  { key: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { key: "12h", label: "12 hours", ms: 12 * 60 * 60 * 1000 },
  { key: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
];

const REFRESH_MS = 30_000; // how often the non-live spans re-poll history
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPARE_REFRESH_MS = REFRESH_MS * 6; // "yesterday" barely changes once written — no need to poll as often

/**
 * The live "Total power" card. "10 min" plots the WebSocket rolling buffer
 * (true live, one point per reading); the wider spans poll /api/history
 * instead — that buffer only ever holds 10 minutes, so anything longer has
 * to come from storage — refreshed every 30s to stay reasonably current
 * without re-fetching on every single reading.
 */
type SeriesKey = "total" | "grid" | "solar" | "yesterday";

// "Now" (the household total) and "Same time yesterday" match what this
// chart always showed before the grid/solar breakdown existed — kept as
// the default so nothing changes for anyone who doesn't touch the legend.
const DEFAULT_VISIBLE: Record<SeriesKey, boolean> = { total: true, grid: false, solar: false, yesterday: true };

export default function LiveTotalPowerCard({ rolling, channels }: { rolling: RollingPoint[]; channels: ChannelMeta[] }) {
  const producerIndexes = channels.filter((c) => c.kind === "producer").map((c) => c.index);
  const [visible, setVisible] = useState(DEFAULT_VISIBLE);
  function toggle(key: SeriesKey) {
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  const [span, setSpan] = useState<Span>("10m");
  const [history, setHistory] = useState<RollingPoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (span === "10m") return;

    let cancelled = false;
    const spanMs = SPANS.find((s) => s.key === span)!.ms;
    setHistory([]);
    setLoading(true);

    function load(isFirst: boolean) {
      const to = Date.now();
      fetchHistory(to - spanMs, to, 300)
        .then((r) => {
          if (cancelled) return;
          setHistory(r.points.map((p) => ({ ts: p.ts, totalPower: p.totalPower, powers: p.channels })));
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled && isFirst) setLoading(false);
        });
    }

    load(true);
    const timer = setInterval(() => load(false), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [span]);

  // "Same time yesterday" reference line — same span, shifted back exactly
  // 24h, then each point's ts is shifted forward by 24h again so it lands
  // on today's time axis right on top of the equivalent moment. Runs for
  // every span, including "10 min" (the live rolling buffer only ever
  // holds today's last 10 minutes, so yesterday's still has to come from
  // /api/history).
  const [compare, setCompare] = useState<RollingPoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    const spanMs = SPANS.find((s) => s.key === span)!.ms;

    function loadCompare() {
      const to = Date.now() - DAY_MS;
      fetchHistory(to - spanMs, to, 300)
        .then((r) => {
          if (cancelled) return;
          setCompare(r.points.map((p) => ({ ts: p.ts + DAY_MS, totalPower: p.totalPower, powers: p.channels })));
        })
        .catch(() => !cancelled && setCompare([]));
    }

    loadCompare();
    const timer = setInterval(loadCompare, COMPARE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [span]);

  const data = span === "10m" ? rolling : history;
  const label = SPANS.find((s) => s.key === span)!.label;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2>Total power — last {label}</h2>
        <div className="range-bar" style={{ gap: 6 }}>
          {SPANS.map((s) => (
            <button key={s.key} className={`range-btn ${span === s.key ? "active" : ""}`} onClick={() => setSpan(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {span !== "10m" && loading && data.length === 0 ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <>
          <LiveChart
            data={data}
            compareData={compare}
            producerIndexes={producerIndexes}
            showTotal={visible.total}
            showGrid={visible.grid}
            showSolar={visible.solar}
            showCompare={visible.yesterday}
          />
          <div className="legend-row" style={{ marginTop: 4 }}>
            <button
              type="button"
              className={`chip ${visible.total ? "active" : ""}`}
              onClick={() => toggle("total")}
              title={visible.total ? "Click to hide" : "Click to show"}
            >
              <span className="swatch" style={{ background: visible.total ? "var(--series-1)" : "var(--baseline)" }} />
              {compare.length >= 2 ? "Now" : "Total (grid + solar)"}
            </button>
            {producerIndexes.length > 0 && (
              <>
                <button
                  type="button"
                  className={`chip ${visible.grid ? "active" : ""}`}
                  onClick={() => toggle("grid")}
                  title={visible.grid ? "Click to hide" : "Click to show"}
                >
                  <span className="swatch" style={{ background: visible.grid ? "var(--series-4)" : "var(--baseline)" }} />
                  Grid
                </button>
                <button
                  type="button"
                  className={`chip ${visible.solar ? "active" : ""}`}
                  onClick={() => toggle("solar")}
                  title={visible.solar ? "Click to hide" : "Click to show"}
                >
                  <span className="swatch" style={{ background: visible.solar ? "var(--series-3)" : "var(--baseline)" }} />
                  Solar
                </button>
              </>
            )}
            {compare.length >= 2 && (
              <button
                type="button"
                className={`chip ${visible.yesterday ? "active" : ""}`}
                onClick={() => toggle("yesterday")}
                title={visible.yesterday ? "Click to hide" : "Click to show"}
              >
                <span
                  className="swatch"
                  style={{
                    background: visible.yesterday
                      ? "repeating-linear-gradient(90deg, var(--status-critical) 0 4px, transparent 4px 7px)"
                      : "var(--baseline)",
                  }}
                />
                Same time yesterday
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
