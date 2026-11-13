// User-editable overlay on top of the structural channel layout in
// channels.js: custom labels ("Solar Panels", "Kitchen", …), whether a
// circuit is a consumer or a producer (e.g. a CT clamped on a solar
// inverter's feed, reporting power it generates rather than draws), and an
// optional per-circuit power calibration factor.
//
// The factor exists alongside the mains-only one in calibration.js for a
// different reason: that one corrects a firmware quirk in how the 3 main
// legs get combined into one number (see channels.js). This one is a
// per-circuit fudge factor for a genuinely different effect — a clamp on an
// inductive load (a compressor motor, say) can read apparent power (V×I)
// rather than true power (V×I×cosθ), so its reported wattage runs high
// specifically while that motor is under load, in a way a single mains-wide
// multiplier can't fix. There's no way to derive it structurally the way
// the mains factor was (no reactive-power reading available to compute a
// real power factor from) — it has to be estimated by comparing this
// circuit's own contribution against the household's independently-known
// total (mains + solar) while it's running, which is exactly what it's
// for: a manual, per-circuit, "make it line up" knob. Defaults to 1 (no
// correction) for every circuit.
//
// Persisted as JSON so labels/kind/factor survive server restarts. Kept
// separate from channels.js (which stays a pure decoder of the wire
// format) so the mutable, user-facing preferences live in one small,
// obvious place.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNEL_COUNT, CHANNEL_META, MAIN_INDEXES } from "./channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_FILE = path.join(DATA_DIR, "channel-config.json");

const MAIN_SET = new Set(MAIN_INDEXES);
const VALID_KINDS = new Set(["consumer", "producer"]);

fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {Record<number, {label?: string, kind?: 'consumer'|'producer', factor?: number}>} */
let overrides = {};

function load() {
  if (!fs.existsSync(CONFIG_FILE)) return;
  try {
    overrides = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    overrides = {};
  }
}

function persist() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(overrides, null, 2));
}

load();

/**
 * Static channel list (labels + configured kind). The 3 main phases are
 * never "consumer" or "producer" — they're the grid tie, its own category —
 * so they always report kind "grid" here.
 */
export function getChannelList() {
  return CHANNEL_META.map((meta) => {
    const o = overrides[meta.index] ?? {};
    return {
      index: meta.index,
      type: meta.type, // 'circuit' | 'main' — structural, not editable
      label: o.label?.trim() || meta.label,
      kind: MAIN_SET.has(meta.index) ? "grid" : o.kind === "producer" ? "producer" : "consumer",
      // Mains use the single mains-wide factor in calibration.js instead —
      // always report 1 here so nothing downstream double-applies both.
      factor: MAIN_SET.has(meta.index) ? 1 : Number.isFinite(o.factor) && o.factor > 0 ? o.factor : 1,
    };
  });
}

export function getChannel(index) {
  return getChannelList().find((c) => c.index === index) ?? null;
}

/**
 * `{ [circuitIndex]: factor }` for only the circuits with a non-default
 * factor set — the shape parseSensePayload's hot path wants, built fresh
 * from `overrides` (not getChannelList()) so it skips decorating every
 * channel just to throw most of it away on every single reading.
 */
export function getChannelFactors() {
  const out = {};
  for (const [i, o] of Object.entries(overrides)) {
    const idx = Number(i);
    if (MAIN_SET.has(idx)) continue;
    if (Number.isFinite(o.factor) && o.factor > 0 && o.factor !== 1) out[idx] = o.factor;
  }
  return out;
}

/**
 * Update a channel's label, kind, and/or calibration factor. Returns the
 * updated channel, or null if the index is out of range / the update is
 * invalid. The 3 main phases don't accept a `kind` or `factor` here — kind
 * is derived automatically, and factor is the separate mains-wide setting
 * in calibration.js.
 */
export function updateChannel(index, { label, kind, factor } = {}) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= CHANNEL_COUNT) return null;
  if (kind !== undefined) {
    if (MAIN_SET.has(i)) return null; // main phases: kind is automatic, not editable
    if (!VALID_KINDS.has(kind)) return null;
  }
  if (factor !== undefined) {
    if (MAIN_SET.has(i)) return null; // main phases: use the mains-wide factor instead
    const f = Number(factor);
    if (!Number.isFinite(f) || f <= 0 || f > 10) return null;
  }

  const current = overrides[i] ?? {};
  const next = { ...current };
  if (label !== undefined) next.label = String(label).slice(0, 60);
  if (kind !== undefined) next.kind = kind;
  if (factor !== undefined) next.factor = Number(factor);
  overrides[i] = next;
  persist();
  return getChannel(i);
}

/**
 * Decorate a parsed reading's channels with current labels/kind, and derive
 * the grid's direction from the live power balance of the *circuit*
 * channels (the mains themselves are excluded from the comparison — they
 * aren't a consumer or a producer, they're the exchange point):
 *
 *   consumerSum = sum of power across circuits configured as consumers
 *   producerSum = sum of power across circuits configured as producers
 *
 *   consumerSum > producerSum  -> local production can't cover the load,
 *                                 so we're pulling the gap from the grid:
 *                                 direction = "importing"
 *   consumerSum <= producerSum -> local production covers (or exceeds) the
 *                                 load, so the surplus is going out to the
 *                                 grid: direction = "exporting"
 *
 * `isDaytime` (default true) guards against a real hardware quirk: a
 * producer channel is a CT clamp on the solar inverter's own circuit, and
 * after dark it still reads a non-trivial positive wattage (a few hundred
 * watts, not "a few watts" as originally assumed) through that *same*
 * clamp, with no way to tell "producing" from whatever this actually is
 * from the number alone. When `isDaytime` is false, producer channels are
 * treated as consumers here for the grid-direction sums above and in each
 * channel's own `kind` in the returned list.
 *
 * Investigated at length (see README's "Power calibration" section): a
 * live A/B test — physically disconnecting the panels outside the panel —
 * stopped it, so it's coming from the panels/inverter itself, not clamp
 * crosstalk from a nearby circuit. But it also isn't real power flowing
 * anywhere: neither "it's production" nor "it's the inverter drawing
 * power" survives checking it against the household's independently-
 * measured grid balance (mains + solar should exactly explain the grid
 * import/export; this reading doesn't move that number either direction).
 * It's authentically the panels' own signal, just not one that means
 * anything physically — so beyond relabeling `kind`, this channel's
 * `power` is zeroed outright in the decorated output whenever it's
 * reclassified, rather than displayed or stored as a real (if small)
 * wattage. The channel's *configured* kind is preserved separately as
 * `configuredKind` so the UI can explain the swap on hover.
 *
 * Returns { channels, direction, consumerSum, producerSum }.
 */
export function decorateChannels(channels, { isDaytime = true } = {}) {
  const list = getChannelList();
  const meta = new Map(list.map((c) => [c.index, c]));

  let consumerSum = 0;
  let producerSum = 0;
  for (const c of channels) {
    if (MAIN_SET.has(c.index)) continue;
    const m = meta.get(c.index);
    const effectiveKind = m?.kind === "producer" && !isDaytime ? "consumer" : m?.kind;
    if (effectiveKind === "producer") producerSum += c.power;
    else consumerSum += c.power;
  }
  const direction = consumerSum > producerSum ? "importing" : "exporting";

  const decorated = channels.map((c) => {
    const m = meta.get(c.index);
    if (!m) return c;
    const reclassifiedAtNight = m.kind === "producer" && !isDaytime;
    return {
      ...c,
      label: m.label,
      kind: reclassifiedAtNight ? "consumer" : m.kind,
      configuredKind: m.kind,
      reclassifiedAtNight,
      // Not just relabeled — the reading itself doesn't correspond to any
      // real power flow once it's reclassified (see header comment), so it
      // shouldn't show up as a nonzero "consumption" wattage either.
      power: reclassifiedAtNight ? 0 : c.power,
    };
  });

  return { channels: decorated, direction, consumerSum, producerSum };
}
