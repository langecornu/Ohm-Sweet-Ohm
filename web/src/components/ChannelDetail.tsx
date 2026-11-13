import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fetchHistory, fetchSummary } from "../api";
import type { ChannelMeta, HistoryPoint, LiveReading, SummaryStats } from "../types";
import RangePicker, { type Range } from "./RangePicker";
import ChartTooltip from "./ChartTooltip";

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

const KIND_COLOR: Record<string, string> = {
  producer: "var(--series-3)",
  consumer: "var(--series-1)",
  grid: "var(--series-4)",
};

export default function ChannelDetail({
  index,
  channels,
  reading,
  onBack,
}: {
  index: number;
  channels: ChannelMeta[];
  reading: LiveReading | null;
  onBack: () => void;
}) {
  const meta = channels.find((c) => c.index === index);
  const live = reading?.channels.find((c) => c.index === index);
  const color = KIND_COLOR[meta?.kind ?? "consumer"];

  const [range, setRange] = useState<Range>(() => {
    const to = Date.now();
    return { from: to - 15 * 60 * 1000, to, label: "15m" };
  });
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [summary, setSummary] = useState<SummaryStats | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchHistory(range.from, range.to, 300), fetchSummary(range.from, range.to, index)])
      .then(([hist, summ]) => {
        if (cancelled) return;
        setPoints(hist.points);
        setSummary(summ);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, index]);

  const timeFmt = range.to - range.from > 20 * 60 * 60 * 1000 ? timeFmtFull : timeFmtShort;
  const chartData = points.map((p) => ({ ts: p.ts, power: p.channels[index] ?? 0 }));

  return (
    <>
      <div className="card">
        <button className="back-link" onClick={onBack}>
          ← Back to channels
        </button>
        <div className="detail-header">
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--text-primary)", textTransform: "none", letterSpacing: 0 }}>
            {meta?.label ?? `Channel ${index}`}
          </h2>
          <span className="kind-pill" style={{ color, borderColor: color }}>
            <span className="dot" style={{ background: color }} />
            {meta?.kind === "producer" ? "Producer" : "Consumer"}
          </span>
        </div>
        <div className="detail-live-row">
          <span className="detail-live-power" style={{ color }}>
            {live ? fmt(live.power) : "—"}
            <span className="unit">W</span>
          </span>
          <span className="detail-live-sub">
            {live ? `${fmt(live.current, 2)} A · ${fmt(live.voltage)} V` : "waiting for live data…"}
          </span>
        </div>
      </div>

      <div className="card">
        <RangePicker range={range} onChange={setRange} context="circuit_detail" />

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
            <div className="label">{meta?.kind === "producer" ? "Energy produced" : "Energy used"}</div>
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
          <div className="empty-state">No data in this range yet.</div>
        ) : view === "chart" ? (
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
                  return (
                    <ChartTooltip
                      timeLabel={timeFmt.format(new Date(label as number))}
                      series={[{ key: "power", label: meta?.label ?? "Power", color, value: (payload[0]?.value as number) ?? 0 }]}
                    />
                  );
                }}
              />
              <Line type="monotone" dataKey="power" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Power (W)</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.ts}>
                    <td>{timeFmtFull.format(new Date(p.ts))}</td>
                    <td>{(p.channels[index] ?? 0).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
