export type ChannelKind = "consumer" | "producer" | "grid";
export type GridDirection = "importing" | "exporting";

export interface ChannelReading {
  index: number;
  label: string;
  type: "circuit" | "main";
  /** Effective kind right now — a producer flips to "consumer" after dark (see reclassifiedAtNight). */
  kind: ChannelKind;
  /** The kind set in Settings, unaffected by day/night — compare against `kind` to detect a night-time swap. */
  configuredKind?: ChannelKind;
  /** True when this channel is configured as a producer but it's currently night, so its reading is
   * being counted as (small, standby) consumption rather than production — see channelConfig.js. */
  reclassifiedAtNight?: boolean;
  voltage: number;
  current: number;
  power: number;
  energyIn: number;
  energyOut: number;
}

export interface LiveReading {
  ts: number;
  channels: ChannelReading[];
  /** Signed: positive while importing from the grid, negative while exporting to it. */
  totalPower: number;
  totalEnergyIn: number;
  totalEnergyOut: number;
  totalCurrent: number;
  avgVoltage: number;
  gridDirection: GridDirection;
}

export interface ChannelMeta {
  index: number;
  label: string;
  type: "circuit" | "main";
  kind: ChannelKind;
  /** Per-circuit power calibration multiplier (default 1). Always 1 for
   * "main" channels — those use the separate mains-wide factor instead. */
  factor: number;
}

export interface HistoryPoint {
  ts: number;
  totalPower: number;
  channels: number[]; // power per channel index
}

export interface SummaryStats {
  from: number;
  to: number;
  sampleCount: number;
  avgPower: number;
  maxPower: number;
  minPower: number;
  energyInKwh: number;
  energyOutKwh: number;
}

export type MqttState = "connecting" | "connected" | "reconnecting" | "error" | "offline";

export interface StatusMsg {
  state: MqttState;
  detail?: string;
}

export interface CircuitUsage {
  index: number;
  label: string;
  kind: "consumer" | "producer";
  avgPower: number;
  peakPower: number;
  minPower: number;
  stdDevPower: number;
  kwh: number;
  sharePct: number;
}

export interface HourOfDayStat {
  hour: number;
  avgGridPower: number;
  sampleCount: number;
  circuitAvgPower: number[];
  topCircuit: { index: number; label: string; avgPower: number } | null;
}

export interface WeekdayStat {
  weekday: number;
  label: string;
  avgGridPower: number;
  avgHouseholdPower: number;
  sampleCount: number;
}

export interface WeekStat {
  weekStart: number;
  label: string;
  importKwh: number;
  exportKwh: number;
  netKwh: number;
}

export interface GridBalance {
  importPct: number;
  exportPct: number;
  importKwh: number;
  exportKwh: number;
  netKwh: number;
}

export interface SolarStats {
  producedKwh: number;
  exportedKwh: number;
  selfConsumedKwh: number;
  selfConsumedPct: number;
}

export interface PeakDemand {
  ts: number;
  totalPower: number;
  topCircuit: { index: number; label: string; power: number } | null;
}

export interface StandbyLoad {
  ts: number;
  totalPower: number;
}

export interface AuthState {
  authenticated: boolean;
  email: string | null;
}

export interface WeatherLocation {
  zip: string;
  lat: number;
  lon: number;
  city: string;
  state: string;
}

export interface WeatherPoint {
  ts: number;
  tempF: number;
  /** total consumption = solarPower + gridPower */
  avgPower: number;
  gridPower: number;
  solarPower: number;
}

export interface WeatherCorrelation {
  location: WeatherLocation | null;
  points: WeatherPoint[];
  /** Pearson correlation coefficient (temp vs total power), null if too little data */
  correlation: number | null;
}

export interface DailyWeatherPoint {
  date: string;
  avgTempF: number;
  minTempF: number;
  maxTempF: number;
  totalKwh: number;
  gridImportKwh: number;
  solarKwh: number;
}

export interface WeatherDaily {
  location: WeatherLocation | null;
  days: DailyWeatherPoint[];
  correlation: number | null;
  hottestDay: DailyWeatherPoint | null;
  mildestDay: DailyWeatherPoint | null;
}

export interface TodaySnapshotCircuit {
  index: number;
  label: string;
  kwh: number;
}

export interface TodaySnapshotPeak {
  ts: number;
  totalPower: number;
  gridPower: number;
  solarPower: number;
}

export interface TodayWarmest {
  tempF: number;
  ts: number;
}

export interface TodaySnapshot {
  dayStart: number;
  timezone: string;
  sampleCount: number;
  producedKwh: number;
  gridImportKwh: number;
  totalKwh: number;
  biggestCircuit: TodaySnapshotCircuit | null;
  peak: TodaySnapshotPeak | null;
  warmest: TodayWarmest | null;
  location: { city: string; state: string } | null;
}

/** Same shape as TodaySnapshot, for one arbitrary (usually historical) day
 * — the Daily Snapshots page's detail view. */
export interface DaySnapshot extends TodaySnapshot {
  date: string; // "YYYY-MM-DD"
}

/** Lighter per-day figure for the Daily Snapshots calendar grid — no
 * warmest/location (those are only fetched for the selected day's detail,
 * not for every day in a month at once). */
export interface DailyTotal {
  date: string;
  sampleCount: number;
  producedKwh: number;
  gridImportKwh: number;
  /** Same signed-net convention as billed net-metering usage: pulled from
   * grid minus pushed back to it. */
  gridExportKwh: number;
  totalKwh: number;
  biggestCircuit: TodaySnapshotCircuit | null;
  peak: TodaySnapshotPeak | null;
  warmest: TodayWarmest | null;
}

export interface CalibrationSettings {
  factor: number;
  importGain: number;
  importOffsetW: number;
}

export interface BillingSettings {
  solarBillingDay: number;
  electricBillingDay: number;
  /** SDGE meter-read dates ("YYYY-MM-DD"), each the last day of the cycle it closes. */
  electricReadDates: string[];
}

export interface SdgeRates {
  tier1RatePerKwh: number;
  tier2RatePerKwh: number;
  baselineKwhPerDay: number;
  baseServiceChargePerDay: number;
  season: "summer" | "winter";
  verified: boolean;
  asOfBillDate: string;
}

export interface TierCost {
  baselineKwh: number;
  tier1Kwh: number;
  tier2Kwh: number;
  usageCost: number;
  baseCost: number;
  totalCost: number;
}

/** Cost/tier estimate for an arbitrary period — see server/src/billingCost.js. */
export interface CostEstimate {
  daysElapsed: number;
  totalDays: number;
  daysRemaining: number;
  netKwh: number;
  costToDate: TierCost;
  projectedNetKwh: number;
  costProjected: TierCost;
  rates: SdgeRates;
  /** When the server actually computed this (ms epoch) — the current billing cycle is cached and refreshed every 15 min, not recomputed per request. */
  computedAt: number;
}

export interface AlertSettings {
  enabled: boolean;
  thresholdPct: number;
}

export interface AlexaStatus {
  linked: boolean;
}

export interface DailyEmailSettings {
  enabled: boolean;
  address: string;
}

export interface Analytics {
  from: number;
  to: number;
  sampleCount: number;
  circuits: CircuitUsage[];
  byHourOfDay: HourOfDayStat[];
  byWeekday: WeekdayStat[];
  byWeek: WeekStat[];
  gridBalance: GridBalance | null;
  solar: SolarStats | null;
  peakDemand: PeakDemand | null;
  standbyLoad: StandbyLoad | null;
  mostVolatile: CircuitUsage[];
}
