import { memo, useEffect, useState } from "react";
import { fetchWeatherLocation, setWeatherZip } from "../api";
import type { WeatherLocation } from "../types";

function WeatherSettings() {
  const [location, setLocation] = useState<WeatherLocation | null>(null);
  const [zip, setZip] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWeatherLocation()
      .then((r) => {
        setLocation(r.location);
        if (r.location) setZip(r.location.zip);
      })
      .catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const r = await setWeatherZip(zip);
      setLocation(r.location);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't save zip code");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>Location (for weather correlation)</h2>
      <p style={{ margin: "-6px 0 16px", fontSize: 12, color: "var(--text-muted)" }}>
        Sets the outdoor temperature used by the "Consumption vs temperature" chart in Analytics.
        Saving a new zip backfills temperature history back to June 1 automatically.
      </p>
      <form onSubmit={save} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="settings-label-input"
          style={{ maxWidth: 140 }}
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          placeholder="5-digit zip"
          pattern="\d{5}"
          maxLength={5}
          required
        />
        <button className="range-btn active" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {location && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {location.city}, {location.state}
          </span>
        )}
      </form>
      {error && <div className="form-error" style={{ marginTop: 10, marginBottom: 0 }}>{error}</div>}
    </div>
  );
}

export default memo(WeatherSettings);
