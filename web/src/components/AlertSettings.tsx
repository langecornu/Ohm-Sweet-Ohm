import { memo, useEffect, useState } from "react";
import { fetchAlertSettings, setAlertSettings as saveAlertSettings } from "../api";
import type { AlertSettings as AlertSettingsData } from "../types";

function AlertSettings() {
  const [settings, setSettings] = useState<AlertSettingsData | null>(null);
  const [thresholdInput, setThresholdInput] = useState("40");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchAlertSettings()
      .then((s) => {
        setSettings(s);
        setThresholdInput(String(s.thresholdPct));
      })
      .catch(() => {});
  }, []);

  async function toggleEnabled() {
    if (!settings) return;
    setError(null);
    try {
      const next = await saveAlertSettings({ enabled: !settings.enabled });
      setSettings(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't save");
    }
  }

  async function saveThreshold(e: React.FormEvent) {
    e.preventDefault();
    const pct = Number(thresholdInput);
    if (!Number.isFinite(pct) || pct < 5 || pct > 500) {
      setError("enter a number between 5 and 500");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const next = await saveAlertSettings({ thresholdPct: pct });
      setSettings(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <div className="card">
      <h2>Usage alerts</h2>
      <p style={{ margin: "-6px 0 16px", fontSize: 12, color: "var(--text-muted)" }}>
        Push a notification to any device that's turned on alerts (the bell icon, top right) when consumption runs
        well above what's typical for that hour of day. Checked every few minutes; at most one alert every 2 hours.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
        <input type="checkbox" checked={settings.enabled} onChange={toggleEnabled} />
        Enable usage alerts
      </label>

      <form onSubmit={saveThreshold} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Alert when usage is</span>
        <input
          className="settings-label-input"
          style={{ maxWidth: 70, textAlign: "right" }}
          type="number"
          min={5}
          max={500}
          value={thresholdInput}
          onChange={(e) => setThresholdInput(e.target.value)}
        />
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>% above the usual for that hour</span>
        <button className="range-btn active" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span style={{ fontSize: 12, color: "var(--status-good)" }}>Saved</span>}
      </form>
      {error && (
        <div className="form-error" style={{ marginTop: 10, marginBottom: 0 }}>
          {error}
        </div>
      )}
    </div>
  );
}

export default memo(AlertSettings);
