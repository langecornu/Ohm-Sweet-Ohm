import { memo, useEffect, useState } from "react";
import { fetchAlexaStatus, triggerAlexaRoutine } from "../api";
import type { AlexaStatus } from "../types";

function AlexaSettings() {
  const [status, setStatus] = useState<AlexaStatus | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [result, setResult] = useState<"ok" | "error" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAlexaStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  async function trigger() {
    setTriggering(true);
    setError(null);
    setResult(null);
    try {
      await triggerAlexaRoutine();
      setResult("ok");
    } catch (err) {
      setResult("error");
      setError(err instanceof Error ? err.message : "trigger failed");
    } finally {
      setTriggering(false);
      setTimeout(() => setResult(null), 4000);
    }
  }

  if (!status) return null;

  return (
    <div className="card">
      <h2>Alexa Routine trigger</h2>
      <p style={{ margin: "-6px 0 16px", fontSize: 12, color: "var(--text-muted)" }}>
        Fires an Alexa Routine you set up yourself in the Alexa app (e.g. "AC Boost" → set the thermostat to a
        temperature). This button flips a virtual switch Alexa can see — it never talks to the thermostat directly.
      </p>

      {status.linked ? (
        <>
          <button className="range-btn active" onClick={trigger} disabled={triggering}>
            {triggering ? "Triggering…" : "Trigger “AC Boost”"}
          </button>
          {result === "ok" && <span style={{ marginLeft: 10, fontSize: 12, color: "var(--status-good)" }}>Sent — check Alexa.</span>}
        </>
      ) : (
        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Not linked yet. In the Alexa app, find the <strong>Ohm Sweet Ohm</strong> skill and link your account (you'll
          sign in with this dashboard's admin login), then create a Routine: <em>When "AC Boost" turns on → [your action]</em>.
        </div>
      )}
      {error && (
        <div className="form-error" style={{ marginTop: 10, marginBottom: 0 }}>
          {error}
        </div>
      )}
    </div>
  );
}

export default memo(AlexaSettings);
