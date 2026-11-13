import { memo, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchAnalytics, fetchWeatherCorrelation, fetchWeatherDaily } from "../api";
import type { Analytics as AnalyticsData, CircuitUsage, DailyWeatherPoint, WeatherCorrelation, WeatherDaily } from "../types";
import RangePicker, { type Range } from "./RangePicker";
import ChartTooltip from "./ChartTooltip";

const HOUR_LABEL = Array.from({ length: 24 }, (_, h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`));
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun

function fmt(n: number, digits = 1) {
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Plain-English read on a Pearson correlation coefficient. */
function describeCorrelation(r: number | null): string | null {
  if (r === null) return null;
  const abs = Math.abs(r);
  if (abs < 0.2) return `Not really tied to temperature yet (r = ${fmt(r, 2)}).`;
  const strength = abs >= 0.7 ? "Strongly" : abs >= 0.4 ? "Moderately" : "Weakly";
  const direction = r > 0 ? "hotter it gets (likely AC-driven)" : "colder it gets (likely heating-driven)";
  return `${strength} tied to temperature (r = ${fmt(r, 2)}) — more power the ${direction}.`;
}

// Wrapped in memo() (see AboutPage.tsx) — takes no props, so App's every-
// ~2s live-socket re-render skips this whole (chart-heavy, so relatively
// expensive to reconcile) subtree entirely; its own fetches/setState still
// re-render it normally.
function Analytics() {
  const [range, setRange] = useState<Range>(() => {
    const to = Date.now();
    return { from: to - 24 * 60 * 60 * 1000, to, label: "24h" };
  });
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [weather, setWeather] = useState<WeatherCorrelation | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [dailyWeather, setDailyWeather] = useState<WeatherDaily | null>(null);
  const [dailyWeatherLoading, setDailyWeatherLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAnalytics(range.from, range.to)
      .then((d) => !cancelled && setData(d))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to]);

  // Independent of the main analytics fetch above — each section renders as
  // soon as its own data is ready rather than waiting on the slowest one.
  useEffect(() => {
    let cancelled = false;
    setWeatherLoading(true);
    fetchWeatherCorrelation(range.from, range.to)
      .then((d) => !cancelled && setWeather(d))
      .catch(() => !cancelled && setWeather(null))
      .finally(() => !cancelled && setWeatherLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to]);

  // The daily temp-vs-consumption trend is a longer-term view than the hourly
  // range picker offers (max preset is 7d) — always pull the last 90 days.
  useEffect(() => {
    let cancelled = false;
    const to = Date.now();
    const from = to - 90 * 24 * 60 * 60 * 1000;
    fetchWeatherDaily(from, to)
      .then((d) => !cancelled && setDailyWeather(d))
      .catch(() => !cancelled && setDailyWeather(null))
      .finally(() => !cancelled && setDailyWeatherLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const consumerCircuits = useMemo(() => data?.circuits.filter((c) => c.kind === "consumer") ?? [], [data]);
  const producerCircuits = useMemo(() => data?.circuits.filter((c) => c.kind === "producer") ?? [], [data]);
  const maxKwh = Math.max(1, ...(data?.circuits.map((c) => c.kwh) ?? [1]));

  return (
    <>
      <div className="card">
        <h2>Analytics</h2>
        <RangePicker range={range} onChange={setRange} context="analytics" />
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>
          {loading ? "Crunching…" : data ? `${data.sampleCount.toLocaleString()} samples analyzed` : ""}
        </div>
      </div>

      {!data ? (
        <>
          {/* ---- Skeletons: shown immediately on open, before the analytics query resolves ---- */}
          <div className="card">
            <h2>Usage by circuit</h2>
            <SkeletonUsageList rows={7} />
          </div>
          <div className="card">
            <h2>Notable metrics</h2>
            <SkeletonTiles />
          </div>
          <div className="card">
            <h2>When you pull from vs push to the grid</h2>
            <SkeletonChart height={220} />
          </div>
          <div className="card">
            <h2>Most-consuming circuits by hour of day</h2>
            <SkeletonChart height={180} />
          </div>
          <div className="card">
            <h2>Typical load by day of week</h2>
            <SkeletonChart height={200} />
          </div>
          <div className="card">
            <h2>Grid exchange by week</h2>
            <SkeletonChart height={220} />
          </div>
        </>
      ) : data.sampleCount === 0 ? (
        <div className="card">
          <div className="empty-state">No data in this range yet.</div>
        </div>
      ) : (
        <>
          {/* ---- Usage by circuit ---- */}
          <div className="card">
            <h2>Usage by circuit</h2>
            <div className="channel-list">
              {[...producerCircuits, ...consumerCircuits].map((c) => (
                <UsageRow key={c.index} c={c} maxKwh={maxKwh} />
              ))}
            </div>
          </div>

          {/* ---- Notable metrics ---- */}
          <NotableMetrics data={data} />

          {/* ---- Grid direction by hour of day ---- */}
          <div className="card">
            <h2>When you pull from vs push to the grid</h2>
            <p className="chart-caption">Average grid power by hour of day — above zero is importing, below is exporting.</p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.byHourOfDay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--gridline)" vertical={false} />
                <XAxis
                  dataKey="hour"
                  tickFormatter={(h) => HOUR_LABEL[h]}
                  tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                  axisLine={{ stroke: "var(--baseline)" }}
                  tickLine={false}
                  interval={2}
                />
                <YAxis
                  width={54}
                  tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  label={{ value: "W", position: "insideTopLeft", fill: "var(--text-muted)", fontSize: 11, dy: -6 }}
                />
                <ReferenceLine y={0} stroke="var(--baseline)" />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as AnalyticsData["byHourOfDay"][number];
                    if (!d.sampleCount) return null;
                    const importing = d.avgGridPower >= 0;
                    return (
                      <ChartTooltip
                        timeLabel={HOUR_LABEL[d.hour]}
                        series={[
                          {
                            key: "grid",
                            label: importing ? "Pulling from grid" : "Pushing to grid",
                            color: importing ? "var(--series-1)" : "var(--series-3)",
                            value: Math.abs(d.avgGridPower),
                          },
                          ...(d.topCircuit
                            ? [{ key: "top", label: `Top: ${d.topCircuit.label}`, color: "var(--series-4)", value: d.topCircuit.avgPower }]
                            : []),
                        ]}
                      />
                    );
                  }}
                />
                <Bar dataKey="avgGridPower" radius={[3, 3, 3, 3]} isAnimationActive={false}>
                  {data.byHourOfDay.map((d) => (
                    <Cell key={d.hour} fill={d.avgGridPower >= 0 ? "var(--series-1)" : "var(--series-3)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="legend-row" style={{ marginTop: 4 }}>
              <div className="legend-item">
                <span className="swatch" style={{ background: "var(--series-1)" }} />
                Pulling from grid
              </div>
              <div className="legend-item">
                <span className="swatch" style={{ background: "var(--series-3)" }} />
                Pushing to grid
              </div>
            </div>
          </div>

          {/* ---- Heatmap: most-consuming circuit by hour ---- */}
          <div className="card">
            <h2>Most-consuming circuits by hour of day</h2>
            <p className="chart-caption">Darker = more power drawn during that hour, averaged across the whole range.</p>
            <HourHeatmap data={data} />
          </div>

          {/* ---- Day of week ---- */}
          <div className="card">
            <h2>Typical load by day of week</h2>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={WEEKDAY_ORDER.map((wd) => data.byWeekday[wd])}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid stroke="var(--gridline)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                  axisLine={{ stroke: "var(--baseline)" }}
                  tickLine={false}
                />
                <YAxis
                  width={54}
                  tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  label={{ value: "W", position: "insideTopLeft", fill: "var(--text-muted)", fontSize: 11, dy: -6 }}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as AnalyticsData["byWeekday"][number];
                    if (!d.sampleCount) return null;
                    return (
                      <ChartTooltip
                        timeLabel={d.label}
                        series={[{ key: "load", label: "Avg household load", color: "var(--series-1)", value: d.avgHouseholdPower }]}
                      />
                    );
                  }}
                />
                <Bar dataKey="avgHouseholdPower" fill="var(--series-1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* ---- Grid exchange by week ---- */}
          <div className="card">
            <h2>Grid exchange by week</h2>
            {data.byWeek.length === 0 ? (
              <div className="empty-state">Not enough data yet to show a week-over-week trend.</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.byWeek.map((w) => ({ ...w, exportNeg: -w.exportKwh }))} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--gridline)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                      axisLine={{ stroke: "var(--baseline)" }}
                      tickLine={false}
                    />
                    <YAxis
                      width={54}
                      tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      label={{ value: "kWh", position: "insideTopLeft", fill: "var(--text-muted)", fontSize: 11, dy: -6 }}
                    />
                    <ReferenceLine y={0} stroke="var(--baseline)" />
                    <Legend
                      verticalAlign="top"
                      height={28}
                      formatter={(value) => <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{value}</span>}
                    />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as { importKwh: number; exportKwh: number };
                        return (
                          <ChartTooltip
                            timeLabel={label as string}
                            series={[
                              { key: "import", label: "Imported", color: "var(--series-1)", value: d.importKwh, unit: "kWh" },
                              { key: "export", label: "Exported", color: "var(--series-3)", value: d.exportKwh, unit: "kWh" },
                            ]}
                          />
                        );
                      }}
                    />
                    <Bar dataKey="importKwh" name="Imported" fill="var(--series-1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    <Bar dataKey="exportNeg" name="Exported" fill="var(--series-3)" radius={[0, 0, 3, 3]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </>
            )}
          </div>

        </>
      )}

      {/* ---- Consumption vs outdoor temperature ---- */}
      {/* Independent of the analytics fetch above — renders as soon as its own data is ready. */}
      {weatherLoading ? (
        <div className="card">
          <h2>Consumption vs outdoor temperature</h2>
          <SkeletonChart height={280} />
        </div>
      ) : (
        <WeatherCorrelationChart weather={weather} />
      )}
      {weatherLoading || dailyWeatherLoading ? (
        <div className="card">
          <h2>Temperature and consumption over time</h2>
          <SkeletonChart height={280} />
        </div>
      ) : (
        <TimeSeriesChart hourly={weather} daily={dailyWeather} />
      )}
    </>
  );
}

/** Pulsing placeholder block — the base building block for every skeleton below. */
function SkeletonBlock({ style }: { style?: CSSProperties }) {
  return <div className="skeleton" style={style} />;
}

function SkeletonUsageList({ rows = 6 }: { rows?: number }) {
  return (
    <div className="channel-list">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="channel-row" key={i}>
          <SkeletonBlock style={{ height: 12, width: "70%" }} />
          <SkeletonBlock style={{ height: 10, borderRadius: 5 }} />
          <SkeletonBlock style={{ height: 12, width: "60%", marginLeft: "auto" }} />
        </div>
      ))}
    </div>
  );
}

function SkeletonTiles({ count = 3 }: { count?: number }) {
  return (
    <div className="hero-row">
      {Array.from({ length: count }).map((_, i) => (
        <div className="stat-tile" key={i}>
          <SkeletonBlock style={{ height: 10, width: "50%", marginBottom: 10 }} />
          <SkeletonBlock style={{ height: 30, width: "75%" }} />
        </div>
      ))}
    </div>
  );
}

function SkeletonChart({ height = 220 }: { height?: number }) {
  return <SkeletonBlock style={{ height, borderRadius: 10 }} />;
}

function WeatherCorrelationChart({ weather }: { weather: WeatherCorrelation | null }) {
  return (
    <div className="card">
      <h2>Consumption vs outdoor temperature</h2>
      {!weather?.location ? (
        <div className="empty-state">Set a zip code in Settings to unlock this chart.</div>
      ) : weather.points.length < 3 ? (
        <div className="empty-state">Not enough overlapping data + temperature history in this range yet.</div>
      ) : (
        <>
          <p className="chart-caption">
            One point per hour in {weather.location.city}, {weather.location.state} — total consumption (solar
            produced + grid imported) vs. outdoor temperature.
            {describeCorrelation(weather.correlation) ? ` ${describeCorrelation(weather.correlation)}` : ""}
          </p>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
              <CartesianGrid stroke="var(--gridline)" />
              <XAxis
                dataKey="tempF"
                type="number"
                name="Temperature"
                tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                axisLine={{ stroke: "var(--baseline)" }}
                tickLine={false}
                label={{ value: "°F", position: "insideBottom", offset: -4, fill: "var(--text-muted)", fontSize: 11 }}
              />
              <YAxis
                dataKey="avgPower"
                type="number"
                name="Power"
                width={54}
                tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                label={{ value: "W", position: "insideTopLeft", fill: "var(--text-muted)", fontSize: 11, dy: -6 }}
              />
              <Tooltip
                cursor={{ stroke: "var(--baseline)" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as WeatherCorrelation["points"][number];
                  return (
                    <ChartTooltip
                      timeLabel={new Date(p.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" })}
                      series={[
                        { key: "temp", label: "Outdoor temp", color: "var(--series-4)", value: p.tempF, unit: "°F" },
                        { key: "grid", label: p.gridPower >= 0 ? "Grid (pulling)" : "Grid (pushing)", color: "var(--series-2)", value: p.gridPower, unit: "W" },
                        { key: "solar", label: "Solar", color: "var(--series-3)", value: p.solarPower, unit: "W" },
                        { key: "total", label: "Total consumption", color: "var(--series-1)", value: p.avgPower, unit: "W" },
                      ]}
                    />
                  );
                }}
              />
              <Scatter data={weather.points} fill="var(--series-1)" fillOpacity={0.65} isAnimationActive={false} />
            </ScatterChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  );
}

/**
 * Time-on-the-x-axis view: outdoor temperature and total consumption as two
 * differently-colored lines. "Hour" plots the currently-selected Analytics
 * range (weather.points); "Day" plots the last 90 days of daily rollups
 * (dailyWeather.days) — always time on x, never temperature.
 */
function TimeSeriesChart({ hourly, daily }: { hourly: WeatherCorrelation | null; daily: WeatherDaily | null }) {
  const [mode, setMode] = useState<"day" | "hour">("day");
  const location = daily?.location ?? hourly?.location ?? null;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2>Temperature and consumption over time</h2>
        <div className="range-bar" style={{ gap: 6 }}>
          <button className={`range-btn ${mode === "day" ? "active" : ""}`} onClick={() => setMode("day")}>
            Day
          </button>
          <button className={`range-btn ${mode === "hour" ? "active" : ""}`} onClick={() => setMode("hour")}>
            Hour
          </button>
        </div>
      </div>

      {!location ? (
        <div className="empty-state">Set a zip code in Settings to unlock this chart.</div>
      ) : mode === "day" ? (
        <DailyTimeSeriesBody weather={daily} />
      ) : (
        <HourlyTimeSeriesBody weather={hourly} />
      )}
    </div>
  );
}

function HourlyTimeSeriesBody({ weather }: { weather: WeatherCorrelation | null }) {
  if (!weather || weather.points.length < 2) {
    return <div className="empty-state">Not enough overlapping data + temperature history in this range yet.</div>;
  }
  const points = [...weather.points].sort((a, b) => a.ts - b.ts);
  return (
    <>
      <p className="chart-caption">
        Outdoor temperature (dashed) against total consumption (solar produced + grid imported), hour by hour
        {weather.location ? ` in ${weather.location.city}, ${weather.location.state}` : ""}.
      </p>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid stroke="var(--gridline)" />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            tickFormatter={(ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" })}
            tick={{ fill: "var(--text-muted)", fontSize: 11 }}
            axisLine={{ stroke: "var(--baseline)" }}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            yAxisId="power"
            width={54}
            tick={{ fill: "var(--text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            label={{ value: "W", position: "insideTopLeft", fill: "var(--series-1)", fontSize: 11, dy: -6 }}
          />
          <YAxis
            yAxisId="temp"
            orientation="right"
            width={44}
            tick={{ fill: "var(--text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            label={{ value: "°F", position: "insideTopRight", fill: "var(--series-4)", fontSize: 11, dy: -6 }}
          />
          <Legend
            verticalAlign="top"
            height={28}
            formatter={(value) => <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{value}</span>}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as WeatherCorrelation["points"][number];
              return (
                <ChartTooltip
                  timeLabel={new Date(p.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" })}
                  series={[
                    { key: "temp", label: "Outdoor temp", color: "var(--series-4)", value: p.tempF, unit: "°F" },
                    { key: "grid", label: p.gridPower >= 0 ? "Grid (pulling)" : "Grid (pushing)", color: "var(--series-2)", value: p.gridPower, unit: "W" },
                    { key: "solar", label: "Solar", color: "var(--series-3)", value: p.solarPower, unit: "W" },
                    { key: "total", label: "Total consumption", color: "var(--series-1)", value: p.avgPower, unit: "W" },
                  ]}
                />
              );
            }}
          />
          <Line yAxisId="power" dataKey="avgPower" name="Total consumption" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line yAxisId="temp" dataKey="tempF" name="Outdoor temp" stroke="var(--series-4)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

function DailyTimeSeriesBody({ weather }: { weather: WeatherDaily | null }) {
  if (!weather || weather.days.length < 2) {
    return (
      <div className="empty-state">
        Not enough full days of data yet — this fills in day by day as the dashboard keeps running (last 90 days
        shown once available).
      </div>
    );
  }
  const days = [...weather.days].sort((a, b) => (a.date < b.date ? -1 : 1));
  return (
    <>
      <p className="chart-caption">
        Daily average outdoor temperature (dashed) against total consumption (solar produced + grid imported), last
        90 days.
        {describeCorrelation(weather.correlation) ? ` ${describeCorrelation(weather.correlation)}` : ""}
      </p>

      {(weather.hottestDay || weather.mildestDay) && (
        <div className="hero-row" style={{ marginBottom: 16 }}>
          {weather.hottestDay && (
            <div className="stat-tile">
              <div className="label">Hottest day</div>
              <div className="value" style={{ color: "var(--series-2)" }}>
                {fmt(weather.hottestDay.avgTempF)}
                <span className="unit">°F avg</span>
              </div>
              <div className="sub">
                {new Date(weather.hottestDay.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ·{" "}
                {fmt(weather.hottestDay.totalKwh, 1)} kWh used
              </div>
            </div>
          )}
          {weather.mildestDay && (
            <div className="stat-tile">
              <div className="label">Mildest day</div>
              <div className="value" style={{ color: "var(--series-1)" }}>
                {fmt(weather.mildestDay.avgTempF)}
                <span className="unit">°F avg</span>
              </div>
              <div className="sub">
                {new Date(weather.mildestDay.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ·{" "}
                {fmt(weather.mildestDay.totalKwh, 1)} kWh used
              </div>
            </div>
          )}
        </div>
      )}

      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={days} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid stroke="var(--gridline)" />
          <XAxis
            dataKey="date"
            tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            tick={{ fill: "var(--text-muted)", fontSize: 11 }}
            axisLine={{ stroke: "var(--baseline)" }}
            tickLine={false}
            minTickGap={30}
          />
          <YAxis
            yAxisId="power"
            width={54}
            tick={{ fill: "var(--text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            label={{ value: "kWh", position: "insideTopLeft", fill: "var(--series-1)", fontSize: 11, dy: -6 }}
          />
          <YAxis
            yAxisId="temp"
            orientation="right"
            width={44}
            tick={{ fill: "var(--text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            label={{ value: "°F", position: "insideTopRight", fill: "var(--series-4)", fontSize: 11, dy: -6 }}
          />
          <Legend
            verticalAlign="top"
            height={28}
            formatter={(value) => <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{value}</span>}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as DailyWeatherPoint;
              return (
                <ChartTooltip
                  timeLabel={new Date(d.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                  series={[
                    { key: "temp", label: "Avg temp", color: "var(--series-4)", value: d.avgTempF, unit: "°F" },
                    { key: "range", label: "Temp range", color: "var(--series-4)", value: d.maxTempF - d.minTempF, unit: "°F" },
                    { key: "solar", label: "Solar produced", color: "var(--series-3)", value: d.solarKwh, unit: "kWh" },
                    { key: "grid", label: "Grid imported", color: "var(--series-2)", value: d.gridImportKwh, unit: "kWh" },
                    { key: "total", label: "Total consumption", color: "var(--series-1)", value: d.totalKwh, unit: "kWh" },
                  ]}
                />
              );
            }}
          />
          <Line yAxisId="power" dataKey="totalKwh" name="Total consumption" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line yAxisId="temp" dataKey="avgTempF" name="Outdoor temp" stroke="var(--series-4)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

function UsageRow({ c, maxKwh }: { c: CircuitUsage; maxKwh: number }) {
  const color = c.kind === "producer" ? "var(--series-3)" : "var(--series-1)";
  return (
    <div className="channel-row">
      <div className="name">{c.label}</div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${Math.max(2, (c.kwh / maxKwh) * 100)}%`, background: color }} />
      </div>
      <div className="val">
        {fmt(c.kwh, 2)} kWh{c.kind === "consumer" && c.sharePct > 0 ? ` · ${fmt(c.sharePct, 0)}%` : ""}
      </div>
    </div>
  );
}

function NotableMetrics({ data }: { data: AnalyticsData }) {
  return (
    <div className="card">
      <h2>Notable metrics</h2>
      <div className="hero-row">
        {data.peakDemand && (
          <div className="stat-tile">
            <div className="label">Peak demand</div>
            <div className="value">
              {fmt(data.peakDemand.totalPower)}
              <span className="unit">W</span>
            </div>
            <div className="sub">
              at {timeOf(data.peakDemand.ts)}
              {data.peakDemand.topCircuit ? `, mostly ${data.peakDemand.topCircuit.label}` : ""}
            </div>
          </div>
        )}
        {data.standbyLoad && (
          <div className="stat-tile">
            <div className="label">Standby / baseline load</div>
            <div className="value">
              {fmt(data.standbyLoad.totalPower)}
              <span className="unit">W</span>
            </div>
            <div className="sub">lowest draw, at {timeOf(data.standbyLoad.ts)} — your always-on floor</div>
          </div>
        )}
        {data.gridBalance && (
          <div className="stat-tile">
            <div className="label">Grid balance</div>
            <div className="value">
              {fmt(data.gridBalance.importPct, 0)}<span className="unit">% pulling</span>
            </div>
            <div className="sub">
              {fmt(data.gridBalance.exportPct, 0)}% pushing · net {data.gridBalance.netKwh >= 0 ? "+" : ""}
              {fmt(data.gridBalance.netKwh, 2)} kWh
            </div>
          </div>
        )}
      </div>

      {data.solar && (
        <div className="hero-row" style={{ marginTop: 12 }}>
          <div className="stat-tile">
            <div className="label">Solar produced</div>
            <div className="value" style={{ color: "var(--series-3)" }}>
              {fmt(data.solar.producedKwh, 2)}
              <span className="unit">kWh</span>
            </div>
          </div>
          <div className="stat-tile">
            <div className="label">Self-consumed</div>
            <div className="value" style={{ color: "var(--series-3)" }}>
              {fmt(data.solar.selfConsumedPct, 0)}
              <span className="unit">%</span>
            </div>
            <div className="sub">{fmt(data.solar.selfConsumedKwh, 2)} kWh used directly, rest exported</div>
          </div>
          <div className="stat-tile">
            <div className="label">Solar exported</div>
            <div className="value" style={{ color: "var(--series-3)" }}>
              {fmt(data.solar.exportedKwh, 2)}
              <span className="unit">kWh</span>
            </div>
          </div>
        </div>
      )}

      {data.mostVolatile.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="channel-group-title" style={{ marginTop: 0 }}>
            Most cycling / fluctuating circuits
          </div>
          <div className="channel-list">
            {data.mostVolatile.map((c) => (
              <div className="channel-row" key={c.index}>
                <div className="name">{c.label}</div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{
                      width: `${Math.max(2, (c.stdDevPower / data.mostVolatile[0].stdDevPower) * 100)}%`,
                      background: "var(--series-4)",
                    }}
                  />
                </div>
                <div className="val">±{fmt(c.stdDevPower)} W</div>
              </div>
            ))}
          </div>
          <p className="chart-caption" style={{ marginTop: 8 }}>
            High swing usually means a thermostat, compressor, or other cycling load.
          </p>
        </div>
      )}
    </div>
  );
}

function HourHeatmap({ data }: { data: AnalyticsData }) {
  const rows = useMemo(
    () =>
      data.circuits
        .filter((c) => c.kind === "consumer")
        .slice(0, 8),
    [data]
  );
  const globalMax = Math.max(1, ...rows.flatMap((r) => data.byHourOfDay.map((h) => h.circuitAvgPower[r.index] ?? 0)));

  if (rows.length === 0) return <div className="empty-state">No circuit data yet.</div>;

  return (
    <div className="heatmap-wrap">
      <div className="heatmap-grid" style={{ gridTemplateColumns: `140px repeat(24, 1fr)` }}>
        <div />
        {HOUR_LABEL.map((label, h) => (
          <div key={h} className="heatmap-hour-label">
            {h % 3 === 0 ? label : ""}
          </div>
        ))}
        {rows.map((row) => (
          <RowCells key={row.index} row={row} data={data} globalMax={globalMax} />
        ))}
      </div>
    </div>
  );
}

function RowCells({ row, data, globalMax }: { row: CircuitUsage; data: AnalyticsData; globalMax: number }) {
  return (
    <>
      <div className="heatmap-row-label" title={row.label}>
        {row.label}
      </div>
      {data.byHourOfDay.map((h) => {
        const v = h.circuitAvgPower[row.index] ?? 0;
        const isTop = h.topCircuit?.index === row.index;
        const opacity = h.sampleCount ? Math.min(1, 0.08 + (v / globalMax) * 0.92) : 0;
        return (
          <div
            key={h.hour}
            className={`heatmap-cell ${isTop ? "top" : ""}`}
            style={{ background: h.sampleCount ? "var(--series-1)" : "var(--gridline)", opacity: h.sampleCount ? opacity : 0.4 }}
            title={h.sampleCount ? `${HOUR_LABEL[h.hour]} · ${row.label}: ${fmt(v)} W` : `${HOUR_LABEL[h.hour]}: no data`}
          />
        );
      })}
    </>
  );
}

export default memo(Analytics);
