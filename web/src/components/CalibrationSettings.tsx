import { memo, useEffect, useState } from "react";
import { fetchCalibrationSettings, setCalibrationFactor as saveCalibrationFactor, setImportCorrection } from "../api";

const SQRT3_INVERSE = 1 / Math.sqrt(3);
// Fit against SDGE's 15-minute Green Button intervals, Sep 1 - Oct 15 2026 (see README).
const FITTED_IMPORT = { gain: 0.883, offsetW: 137 };

function CalibrationSettings() {
  const [factor, setFactor] = useState<number | null>(null);
  const [input, setInput] = useState("1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [importCorr, setImportCorr] = useState<{ gain: number; offsetW: number } | null>(null);
  const [gainInput, setGainInput] = useState("1");
  const [offsetInput, setOffsetInput] = useState("0");
  const [importError, setImportError] = useState<string | null>(null);
  const [importSaved, setImportSaved] = useState(false);

  useEffect(() => {
    fetchCalibrationSettings()
      .then((s) => {
        setFactor(s.factor);
        setInput(String(s.factor));
        setImportCorr({ gain: s.importGain, offsetW: s.importOffsetW });
        setGainInput(String(s.importGain));
        setOffsetInput(String(s.importOffsetW));
      })
      .catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const val = Number(input);
    if (!Number.isFinite(val) || val <= 0 || val > 10) {
      setError("enter a number between 0 and 10");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const next = await saveCalibrationFactor(val);
      setFactor(next.factor);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setSaving(false);
    }
  }

  async function saveImport(e: React.FormEvent) {
    e.preventDefault();
    const gain = Number(gainInput);
    const offsetW = Number(offsetInput);
    if (!Number.isFinite(gain) || gain < 0.5 || gain > 2 || !Number.isFinite(offsetW) || Math.abs(offsetW) > 1000) {
      setImportError("gain must be 0.5-2 and offset within ±1000 W");
      return;
    }
    setImportError(null);
    try {
      const next = await setImportCorrection(gain, offsetW);
      setImportCorr({ gain: next.importGain, offsetW: next.importOffsetW });
      setImportSaved(true);
      setTimeout(() => setImportSaved(false), 2000);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "couldn't save");
    }
  }

  if (factor === null) return null;

  return (
    <div className="card">
      <h2>Power calibration</h2>
      <p style={{ margin: "-6px 0 16px", fontSize: 12, color: "var(--text-muted)" }}>
        Multiplies the 3 main-phase readings only — the 16 circuit clamps, and voltage/current everywhere, are left
        alone. This installation's mains measured ~1.73x (≈√3) too high against the utility's own meter, which
        lines up with the device labeling its mains L1/L2/L3 (three-phase) on a 2-leg split-phase home — a
        mains-specific effect that doesn't apply to a single circuit's own clamp (confirmed against real solar
        production data after an earlier version wrongly applied this to circuits too). Set to 1 for no correction.
        New readings pick this up immediately; existing history needs the <code>rescale-readings.js</code> /{" "}
        <code>rescale-circuit-readings.js</code> scripts to match (see README).
      </p>
      <form onSubmit={save} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="settings-label-input"
          style={{ maxWidth: 110 }}
          type="number"
          step="any"
          min={0}
          max={10}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="range-btn active" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="range-btn"
          onClick={() => setInput(SQRT3_INVERSE.toFixed(6))}
          title="1 / √3 — the factor that matched this installation"
        >
          Use 1/√3 ({SQRT3_INVERSE.toFixed(4)})
        </button>
        {saved && <span style={{ fontSize: 12, color: "var(--status-good)" }}>Saved</span>}
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>current: {factor}</span>
      </form>
      {error && (
        <div className="form-error" style={{ marginTop: 10, marginBottom: 0 }}>
          {error}
        </div>
      )}
      <h3 style={{ margin: "20px 0 6px", fontSize: 14 }}>Import correction</h3>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-muted)" }}>
        Applied on top of the factor above, only while importing: true import = (reading − offset) ÷ gain. Against
        SDGE's own 15-minute data, this install's mains read ~10% high at light load and ~10% low with the AC on — a
        gain of 1 and offset of 0 turns it off. Existing history needs <code>rescale-import-readings.js</code> (see
        README).
      </p>
      <form onSubmit={saveImport} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12 }}>
          Gain{" "}
          <input className="settings-label-input" style={{ maxWidth: 80 }} type="number" step="any" value={gainInput} onChange={(e) => setGainInput(e.target.value)} />
        </label>
        <label style={{ fontSize: 12 }}>
          Offset (W){" "}
          <input className="settings-label-input" style={{ maxWidth: 80 }} type="number" step="any" value={offsetInput} onChange={(e) => setOffsetInput(e.target.value)} />
        </label>
        <button className="range-btn active" type="submit">
          Save
        </button>
        <button
          type="button"
          className="range-btn"
          onClick={() => {
            setGainInput(String(FITTED_IMPORT.gain));
            setOffsetInput(String(FITTED_IMPORT.offsetW));
          }}
        >
          Use fitted ({FITTED_IMPORT.gain}, {FITTED_IMPORT.offsetW} W)
        </button>
        {importSaved && <span style={{ fontSize: 12, color: "var(--status-good)" }}>Saved</span>}
        {importCorr && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            current: {importCorr.gain}, {importCorr.offsetW} W
          </span>
        )}
      </form>
      {importError && (
        <div className="form-error" style={{ marginTop: 10, marginBottom: 0 }}>
          {importError}
        </div>
      )}
    </div>
  );
}

export default memo(CalibrationSettings);
