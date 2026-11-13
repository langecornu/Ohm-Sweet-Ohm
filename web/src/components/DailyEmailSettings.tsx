import { memo, useEffect, useState } from "react";
import { fetchDailyEmailSettings, setDailyEmailSettings as saveDailyEmailSettings, sendTestDailyEmail } from "../api";
import type { DailyEmailSettings as DailyEmailSettingsData } from "../types";

function DailyEmailSettings() {
  const [settings, setSettings] = useState<DailyEmailSettingsData | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchDailyEmailSettings()
      .then((s) => {
        setSettings(s);
        setAddressInput(s.address);
      })
      .catch(() => {});
  }, []);

  async function toggleEnabled() {
    if (!settings) return;
    setError(null);
    try {
      const next = await saveDailyEmailSettings({ enabled: !settings.enabled });
      setSettings(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't save");
    }
  }

  async function saveAddress(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const next = await saveDailyEmailSettings({ address: addressInput.trim() });
      setSettings(next);
      setAddressInput(next.address);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTestState("sending");
    setTestMessage(null);
    try {
      const r = await sendTestDailyEmail();
      setTestState("sent");
      setTestMessage(`Sent for ${r.date} to ${r.address}`);
    } catch (err) {
      setTestState("error");
      setTestMessage(err instanceof Error ? err.message : "couldn't send");
    }
  }

  if (!settings) return null;

  return (
    <div className="card">
      <h2>Daily email report</h2>
      <p style={{ margin: "-6px 0 16px", fontSize: 12, color: "var(--text-muted)" }}>
        A rich recap of yesterday — produced, pulled from grid, biggest circuit, peak consumption and production,
        self-consumption, plus how this month compares to last month at the same point — sent once, right after each
        local day finishes.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
        <input type="checkbox" checked={settings.enabled} onChange={toggleEnabled} />
        Send the daily email report
      </label>

      <form onSubmit={saveAddress} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Send to</span>
        <input
          className="settings-label-input"
          style={{ maxWidth: 240 }}
          type="email"
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          placeholder="you@example.com"
        />
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

      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button className="range-btn" type="button" onClick={sendTest} disabled={testState === "sending"}>
          {testState === "sending" ? "Sending…" : "Send test email now"}
        </button>
        {testState === "sent" && <span style={{ fontSize: 12, color: "var(--status-good)" }}>{testMessage}</span>}
        {testState === "error" && <span style={{ fontSize: 12, color: "var(--status-critical)" }}>{testMessage}</span>}
      </div>
    </div>
  );
}

export default memo(DailyEmailSettings);
