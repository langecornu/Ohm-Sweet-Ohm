// SEM Meter payload layout, reverse-engineered from the tutorial's
// configuration.yaml screenshots + a live capture on mqtt001.tumblevd.com:
//
//   payload.sense = [ [v, i, p, energyIn, energyOut], ... 19 rows ]
//
//   row 0-15  -> 16 individually monitored breaker/circuit channels
//   row 16-18 -> 3 "MAIN" phase feeds (L1/L2/L3); the HA "MAIN ..." sensors
//                sum these three rows
//
//   column scale factors: voltage *0.1 (V), current *0.01 (A),
//   power *0.01 (W), energyIn/energyOut *0.001 (kWh, cumulative counters)
//
//   power/energy on the 3 MAIN channels only also take an optional
//   calibration multiplier (see calibration.js) — this installation's
//   *mains* power/energy readings measured ~√3 too high against the
//   utility's own meter, consistent with a three-phase power formula on
//   what's actually a 2-leg split-phase service (this device labels its
//   mains L1/L2/L3, and L3 always reads 0). That's a mains-specific
//   mechanism — it's about how the firmware *combines* 3 leg readings
//   into one, which a single individually-clamped circuit reading never
//   goes through — so the 16 circuit channels are left at their raw
//   scaled values, uncalibrated. Confirmed the hard way: applying the
//   same factor to circuits too (an earlier version of this) initially
//   looked reasonable but under-reported solar production by the same
//   ~√3 against the solar company's own daily production numbers — see
//   README's "Power calibration" section for the full comparison.
//   Voltage/current are left unscaled everywhere — both independently
//   look physically plausible on their own; it's specifically the
//   derived power value that's off, which is what the multiplier
//   corrects, and only for the channels that actually need it.

export const CHANNEL_COUNT = 19;
export const CIRCUIT_COUNT = 16;
export const MAIN_INDEXES = [16, 17, 18];

export function channelLabel(i) {
  return i < CIRCUIT_COUNT ? `Circuit ${i + 1}` : `Main L${i - CIRCUIT_COUNT + 1}`;
}

export function channelType(i) {
  return i < CIRCUIT_COUNT ? "circuit" : "main";
}

export const CHANNEL_META = Array.from({ length: CHANNEL_COUNT }, (_, i) => ({
  index: i,
  label: channelLabel(i),
  type: channelType(i),
}));

/**
 * Parse a raw SEM meter MQTT payload into a fully-scaled reading.
 * Returns null if the payload doesn't look like a sense frame.
 * `calibrationFactor` (default 1, i.e. no-op) multiplies the 3 main
 * channels' power/energy only — see the header comment above for why.
 * `circuitFactors` (default {}, i.e. no-op) is a `{ [index]: factor }` map
 * of *per-circuit* corrections — see channelConfig.js's header comment for
 * why a circuit might need its own factor (an inductive load's clamp
 * reading apparent rather than true power) distinct from the mains one.
 */
export function parseSensePayload(raw, calibrationFactor = 1, circuitFactors = {}) {
  if (!raw || !Array.isArray(raw.sense)) return null;

  const channels = raw.sense.map((row, i) => {
    const [v = 0, cur = 0, p = 0, eIn = 0, eOut = 0] = row;
    const factor = MAIN_INDEXES.includes(i) ? calibrationFactor : circuitFactors[i] ?? 1;
    return {
      index: i,
      label: channelLabel(i),
      type: channelType(i),
      voltage: round2(v * 0.1),
      current: round3(cur * 0.01),
      power: round2(p * 0.01 * factor),
      energyIn: round4(eIn * 0.001 * factor),
      energyOut: round4(eOut * 0.001 * factor),
    };
  });

  const mains = MAIN_INDEXES.map((i) => channels[i]).filter(Boolean);
  const totalPower = round2(mains.reduce((s, c) => s + c.power, 0));
  const totalEnergyIn = round4(mains.reduce((s, c) => s + c.energyIn, 0));
  const totalEnergyOut = round4(mains.reduce((s, c) => s + c.energyOut, 0));
  const totalCurrent = round3(mains.reduce((s, c) => s + c.current, 0));
  const avgVoltage = mains.length ? round2(mains.reduce((s, c) => s + c.voltage, 0) / mains.length) : 0;

  return {
    ts: Date.now(),
    channels,
    totalPower,
    totalEnergyIn,
    totalEnergyOut,
    totalCurrent,
    avgVoltage,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
