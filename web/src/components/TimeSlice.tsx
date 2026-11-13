import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchHistory, fetchSummary } from "../api";
import type { ChannelMeta, HistoryPoint, SummaryStats } from "../types";
import RangePicker, { type Range } from "./RangePicker";
import ChartTooltip from "./ChartTooltip";

const COMPARE_COLORS = ["var(--series-2)", "var(--series-3)", "var(--series-4)"];
const MAX_COMPARE = 3;

const timeFmtShort = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const timeFmtFull = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function fmt(n: number, digits = 1) {
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Wrapped in memo() (see AboutPage.tsx) — `channels` is a stable array
// reference between real changes, so this skips App's every-~2s live-socket
// re-render entirely; its own fetches/setState still re-render it normally.
function TimeSlice({ channels }: { channels: ChannelMeta[] }) {
  const [range, setRange] = useState<Range>(() => {
    const to = Date.now();
    return { from: to - 15 * 60 * 1000, to, label: "15m" };
  });
  const [compare, setCompare] = useState<number[]>([]);
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [summary, setSummary] = useState<SummaryStats | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [hist, summ] = await Promise.all([
          fetchHistory(range.from, range.to, 300),
          fetchSummary(range.from, range.to),
        ]);
        if (!cancelled) {
          setPoints(hist.points);
          setSummary(summ);
        }
      } catch {
        /* backend momentarily unavailable; keep last good data */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();

    clearInterval(pollRef.current);
    if (range.label !== "custom") {
      // "live" presets stay fresh as time moves forward
      pollRef.current = setInterval(() => {
        const to = Date.now();
        const span = range.to - range.from;
        setRange((r) => ({ ...r, from: to - span, to }));
      }, 5000);
    }
    return () => {
      cancelled = true;
      clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  const chartData = useMemo(
    () =>
      points.map((p) => {
        const row: Record<string, number> = { ts: p.ts, total: p.totalPower };
        compare.forEach((idx) => {
          row[`ch${idx}`] = p.channels[idx] ?? 0;
        });
        return row;
      }),
    [points, compare]
  );

  const timeFmt = range.to - range.from > 20 * 60 * 60 * 1000 ? timeFmtFull : timeFmtShort;

  function toggleChannel(idx: number) {
    setCompare((prev) => {
      if (prev.includes(idx)) return prev.filter((i) => i !== idx);
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, idx];
    });
  }

  return (
    <div className="card">
      <h2>Slice of time</h2>
      <RangePicker range={range} onChange={setRange} context="slice_of_time" />

      <div style={{ marginTop: 16 }}>
        <div className="channel-select">
          {channels.map((c) => {
            const active = compare.includes(c.index);
            const colorIdx = compare.indexOf(c.index);
            return (
              <button
                key={c.index}
                className={`chip ${active ? "active" : ""}`}
                style={active ? { color: COMPARE_COLORS[colorIdx] } : undefined}
                disabled={!active && compare.length >= MAX_COMPARE}
                onClick={() => toggleChannel(c.index)}
                title={active ? "Click to remove from comparison" : "Compare this channel against total"}
              >
                <span className="swatch" style={{ background: active ? COMPARE_COLORS[colorIdx] : "var(--baseline)" }} />
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="hero-row" style={{ marginTop: 16 }}>
        <div className="stat-tile">
          <div className="label">Avg power</div>
          <div className="value">
            {summary ? fmt(summary.avgPower) : "—"}
            <span className="unit">W</span>
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Peak power</div>
          <div className="value">
            {summary ? fmt(summary.maxPower) : "—"}
            <span className="unit">W</span>
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Energy imported</div>
          <div className="value">
            {summary ? fmt(summary.energyInKwh, 2) : "—"}
            <span className="unit">kWh</span>
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Samples</div>
          <div className="value">{summary ? summary.sampleCount.toLocaleString() : "—"}</div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", marginTop: 20, marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {loading ? "Refreshing…" : `${new Date(range.from).toLocaleString()} → ${new Date(range.to).toLocaleString()}`}
        </span>
        <div className="view-toggle">
          <button className={`range-btn ${view === "chart" ? "active" : ""}`} onClick={() => setView("chart")}>
            Chart
          </button>
          <button className={`range-btn ${view === "table" ? "active" : ""}`} onClick={() => setView("table")}>
            Table
          </button>
        </div>
      </div>

      {points.length < 2 ? (
        <div className="empty-state">No data in this range yet — the dashboard only has history from when it started collecting.</div>
      ) : view === "chart" ? (
        <>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--gridline)" vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v) => timeFmt.format(new Date(v))}
                tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                axisLine={{ stroke: "var(--baseline)" }}
                tickLine={false}
                minTickGap={50}
              />
              <YAxis
                width={54}
                tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                label={{ value: "W", position: "insideTopLeft", fill: "var(--text-muted)", fontSize: 11, dy: -6 }}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const series = [
                    { key: "total", label: "Total", color: "var(--series-1)", value: (payload.find((p) => p.dataKey === "total")?.value as number) ?? 0 },
                    ...compare.map((idx, i) => ({
                      key: `ch${idx}`,
                      label: channels[idx]?.label ?? `Channel ${idx}`,
                      color: COMPARE_COLORS[i],
                      value: (payload.find((p) => p.dataKey === `ch${idx}`)?.value as number) ?? 0,
                    })),
                  ];
                  return <ChartTooltip timeLabel={timeFmt.format(new Date(label as number))} series={series} />;
                }}
              />
              {compare.length > 0 && (
                <Legend
                  verticalAlign="top"
                  height={28}
                  formatter={(value) => <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{value}</span>}
                />
              )}
              <Line
                type="monotone"
                dataKey="total"
                name="Total"
                stroke="var(--series-1)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              {compare.map((idx, i) => (
                <Line
                  key={idx}
                  type="monotone"
                  dataKey={`ch${idx}`}
                  name={channels[idx]?.label ?? `Channel ${idx}`}
                  stroke={COMPARE_COLORS[i]}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {compare.length === 0 && (
            <div className="legend-row">
              <div className="legend-item">
                <span className="swatch" style={{ background: "var(--series-1)" }} />
                Total power (sum of 3 main phases)
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Total (W)</th>
                {compare.map((idx) => (
                  <th key={idx}>{channels[idx]?.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.ts}>
                  <td>{timeFmtFull.format(new Date(p.ts))}</td>
                  <td>{p.totalPower.toFixed(1)}</td>
                  {compare.map((idx) => (
                    <td key={idx}>{(p.channels[idx] ?? 0).toFixed(1)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default memo(TimeSlice);
