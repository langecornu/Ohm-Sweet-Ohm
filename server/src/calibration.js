// Power calibration: a single multiplicative correction applied to every
// decoded power/energy value. Exists because this installation's readings
// measured ~1.73x (≈√3) too high against the utility's own meter — the
// device labels its 3 main-phase channels L1/L2/L3 (three-phase
// nomenclature) on what's actually a 2-leg split-phase US residential
// service (L3 has always read 0), consistent with a three-phase power
// formula being applied where a straight split-phase sum should be.
// Confirmed against an exact SDGE 15-minute CSV export for the same
// window — see README's "Power calibration" section. Editable in Settings
// (no redeploy needed) in case it needs fine-tuning against more data.
import { db } from "./db.js";

const getStmt = db.prepare("SELECT value FROM app_settings WHERE key = ?");
const setStmt = db.prepare(
  "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

const DEFAULT_FACTOR = 1;

export function getCalibrationFactor() {
  const row = getStmt.get("power_calibration_factor");
  const n = row ? Number(row.value) : DEFAULT_FACTOR;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FACTOR;
}

export function setCalibrationFactor(factor) {
  setStmt.run("power_calibration_factor", String(factor));
  return factor;
}

// Import correction: a gain + offset applied to the mains' total magnitude
// on top of the factor above, only while importing (see index.js's
// withGridDirection()). Fit against 40+ days of SDGE's own 15-minute Green
// Button intervals (Sep 1 - Oct 15, 2026): with the factor alone, import
// reads ~10% high under 1 kW (overnight base load) and ~10% low with the
// AC running (~5 kW) — `app ≈ 0.883 × true + 137 W` — which left the Sep 3
// - Oct 2 bill cycle at 402.9 kWh against SDGE's 424.5. Not something one
// multiplier can fix. Defaults to the identity (gain 1, offset 0) so it's
// opt-in; see README's "Power calibration" section for the numbers.
const DEFAULT_IMPORT_CORRECTION = { gain: 1, offsetW: 0 };

export function getImportCorrection() {
  const row = getStmt.get("import_correction");
  if (!row) return { ...DEFAULT_IMPORT_CORRECTION };
  const { gain, offsetW } = JSON.parse(row.value);
  return Number.isFinite(gain) && gain > 0 && Number.isFinite(offsetW) ? { gain, offsetW } : { ...DEFAULT_IMPORT_CORRECTION };
}

export function setImportCorrection({ gain, offsetW }) {
  setStmt.run("import_correction", JSON.stringify({ gain, offsetW }));
  return { gain, offsetW };
}

/** True import watts for a calibrated mains magnitude reading of `w` watts. */
export function correctImportWatts(w, { gain, offsetW } = getImportCorrection()) {
  return Math.max(0, (w - offsetW) / gain);
}
