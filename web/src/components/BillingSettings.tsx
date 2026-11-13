import { memo, useEffect, useState } from "react";
import { fetchBillingSettings, setBillingSettings as saveBillingSettings } from "../api";
import type { BillingSettings as BillingSettingsData } from "../types";

function BillingSettings() {
  const [settings, setSettings] = useState<BillingSettingsData | null>(null);
  const [solarDay, setSolarDay] = useState("1");
  const [electricDay, setElectricDay] = useState("1");
  const [readDates, setReadDates] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchBillingSettings()
      .then((s) => {
        setSettings(s);
        setSolarDay(String(s.solarBillingDay));
        setElectricDay(String(s.electricBillingDay));
        setReadDates((s.electricReadDates ?? []).join(", "));
      })
      .catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const solar = Number(solarDay);
    const electric = Number(electricDay);
    if (!Number.isInteger(solar) || solar < 1 || solar > 28 || !Number.isInteger(electric) || electric < 1 || electric > 28) {
      setError("both days must be whole numbers between 1 and 28");
      return;
    }
    const reads = readDates.split(/[\s,]+/).filter(Boolean);
    if (reads.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
      setError("meter read dates must be YYYY-MM-DD, separated by commas");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const next = await saveBillingSettings({ solarBillingDay: solar, electricBillingDay: electric, electricReadDates: reads });
      setSettings(next);
      setReadDates(next.electricReadDates.join(", "));
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
      <h2>Billing periods</h2>
      <p style={{ margin: "-6px 0 16px", fontSize: 12, color: "var(--text-muted)" }}>
        The Daily Snapshots page can align its totals to your actual bill cycles instead of the calendar month — set
        the day of the month each cycle starts (leave at 1 to just use the calendar month). SDGE doesn't read the meter
        on a fixed day, so for the electric cycle add each bill's read dates instead — the end of its "Billing Period"
        and its "Next scheduled read date" — and the electric day above is only used past the last one.
      </p>
      <form onSubmit={save} style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
          Solar billing starts on day
          <input
            className="settings-label-input"
            style={{ maxWidth: 70, textAlign: "right" }}
            type="number"
            min={1}
            max={28}
            value={solarDay}
            onChange={(e) => setSolarDay(e.target.value)}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
          Electric billing starts on day
          <input
            className="settings-label-input"
            style={{ maxWidth: 70, textAlign: "right" }}
            type="number"
            min={1}
            max={28}
            value={electricDay}
            onChange={(e) => setElectricDay(e.target.value)}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", flex: "1 1 260px" }}>
          SDGE meter read dates
          <input
            className="settings-label-input"
            type="text"
            placeholder="2026-09-02, 2026-10-02, 2026-11-03"
            value={readDates}
            onChange={(e) => setReadDates(e.target.value)}
          />
        </label>
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

export default memo(BillingSettings);
