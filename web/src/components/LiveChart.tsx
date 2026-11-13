import { useId } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RollingPoint } from "../useLiveSocket";
import ChartTooltip from "./ChartTooltip";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function LiveChart({
  data,
  compareData,
  compareLabel = "Same time yesterday",
  channelIndex,
  label = "Total power",
  color = "var(--series-1)",
  producerIndexes,
  showTotal = true,
  showGrid = true,
  showSolar = true,
  showCompare = true,
}: {
  data: RollingPoint[];
  /**
   * A second series to overlay as a dashed reference line — same shape as
   * `data`, but with each point's `ts` already shifted forward so it lands
   * on today's time axis (e.g. yesterday's readings + 24h). Rendered as its
   * own series (not merged point-by-point into `data`), since the two
   * rarely share exact timestamps — recharts resolves each independently
   * against the shared time axis.
   */
  compareData?: RollingPoint[];
  compareLabel?: string;
  /** plot a single channel's power instead of the household total */
  channelIndex?: number;
  label?: string;
  color?: string;
  /**
   * Channel indexes currently configured as producers (solar). When given
   * (and `channelIndex` is unset, i.e. this is the whole-household chart),
   * grid/solar values are computed alongside the total: net grid power
   * (`totalPower` itself — already signed, importing positive) and solar
   * power (the sum of these indexes' own `powers`). Household total =
   * grid + solar always holds, same identity used in ChannelBars. Computed
   * regardless of the show* toggles below, so flipping one on/off never
   * needs a re-fetch.
   */
  producerIndexes?: number[];
  /** Each series is independently toggleable (a legend-as-buttons row
   * outside this component owns the state); all default to visible. */
  showTotal?: boolean;
  showGrid?: boolean;
  showSolar?: boolean;
  showCompare?: boolean;
}) {
  const gradientId = useId();
  if (data.length < 2) {
    return <div className="empty-state">Collecting live samples…</div>;
  }

  const solarOf = (p: RollingPoint) => (producerIndexes ?? []).reduce((s, i) => s + (p.powers[i] ?? 0), 0);
  const showBreakdown = channelIndex === undefined && !!producerIndexes?.length;
  // `p.totalPower` is net grid power alone (signed: positive importing) —
  // household total is grid + solar produced, the same identity ChannelBars
  // uses. Without a producer list to add back in (channel meta not loaded
  // yet, or a single-circuit chart) fall back to the old grid-only value.
  const valueOf = (p: RollingPoint) =>
    channelIndex !== undefined ? p.powers[channelIndex] ?? 0 : showBreakdown ? p.totalPower + solarOf(p) : p.totalPower;

  const series = data.map((p) => ({
    ts: p.ts,
    value: valueOf(p),
    ...(showBreakdown ? { grid: p.totalPower, solar: solarOf(p) } : {}),
  }));
  const compareSeries = (compareData ?? []).map((p) => ({ ts: p.ts, value: valueOf(p) }));
  const hasCompare = compareSeries.length >= 2 && showCompare;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(v) => timeFmt.format(new Date(v))}
          tick={{ fill: "var(--text-muted)", fontSize: 11 }}
          axisLine={{ stroke: "var(--baseline)" }}
          tickLine={false}
          minTickGap={40}
        />
        <YAxis
          width={54}
          tick={{ fill: "var(--text-muted)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => `${v}`}
          label={{ value: "W", position: "insideTopLeft", fill: "var(--text-muted)", fontSize: 11, dy: -6 }}
        />
        <Tooltip
          content={({ active, payload, label: ts }) => {
            if (!active || !payload?.length) return null;
            // Built from whichever series are actually rendered (each entry
            // only shows up in `payload` when its own component below is
            // mounted), rather than assumed present — so a toggled-off
            // series just doesn't add a row instead of the tooltip guessing
            // at a fallback value.
            const tSeries: { key: string; label: string; color: string; value: number }[] = [];
            const totalEntry = payload.find((p) => p.dataKey === "value" && p.name !== compareLabel);
            if (totalEntry) tSeries.push({ key: "power", label, color, value: totalEntry.value as number });
            const gridEntry = payload.find((p) => p.dataKey === "grid");
            if (gridEntry) tSeries.push({ key: "grid", label: "Grid", color: "var(--series-4)", value: gridEntry.value as number });
            const solarEntry = payload.find((p) => p.dataKey === "solar");
            if (solarEntry) tSeries.push({ key: "solar", label: "Solar", color: "var(--series-3)", value: solarEntry.value as number });
            const yesterdayEntry = payload.find((p) => p.dataKey === "value" && p.name === compareLabel);
            if (yesterdayEntry) {
              tSeries.push({ key: "yesterday", label: compareLabel, color: "var(--status-critical)", value: yesterdayEntry.value as number });
            }
            if (tSeries.length === 0) return null;
            return <ChartTooltip timeLabel={timeFmt.format(new Date(ts as number))} series={tSeries} />;
          }}
        />
        {showTotal && (
          <Area
            type="monotone"
            dataKey="value"
            data={series}
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 4 }}
          />
        )}
        {showBreakdown && showGrid && (
          <Line
            type="monotone"
            dataKey="grid"
            data={series}
            name="Grid"
            stroke="var(--series-4)"
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
            legendType="none"
          />
        )}
        {showBreakdown && showSolar && (
          <Line
            type="monotone"
            dataKey="solar"
            data={series}
            name="Solar"
            stroke="var(--series-3)"
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
            legendType="none"
          />
        )}
        {hasCompare && (
          <Line
            type="monotone"
            dataKey="value"
            data={compareSeries}
            name={compareLabel}
            stroke="var(--status-critical)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
            legendType="none"
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
