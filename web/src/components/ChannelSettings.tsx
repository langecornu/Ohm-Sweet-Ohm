import { useEffect, useRef, useState } from "react";
import { updateChannel } from "../api";
import { trackEvent } from "../analytics";
import type { ChannelMeta, LiveReading } from "../types";

type SaveState = "idle" | "saving" | "saved";

export default function ChannelSettings({
  channels,
  reading,
  onChanged,
}: {
  channels: ChannelMeta[];
  reading: LiveReading | null;
  onChanged: (channels: ChannelMeta[]) => void;
}) {
  const [labels, setLabels] = useState<Record<number, string>>({});
  const [factors, setFactors] = useState<Record<number, string>>({});
  const [factorError, setFactorError] = useState<Record<number, string>>({});
  const [saveState, setSaveState] = useState<Record<number, SaveState>>({});
  const focusedIndex = useRef<number | null>(null);
  const focusedFactorIndex = useRef<number | null>(null);
  const savedFlashTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  // Keep local label text in sync with the server, except for whichever
  // row the user currently has focused (don't clobber an in-progress edit).
  useEffect(() => {
    setLabels((prev) => {
      const next = { ...prev };
      for (const c of channels) {
        if (c.index !== focusedIndex.current) next[c.index] = c.label;
      }
      return next;
    });
    setFactors((prev) => {
      const next = { ...prev };
      for (const c of channels) {
        if (c.index !== focusedFactorIndex.current) next[c.index] = String(c.factor);
      }
      return next;
    });
  }, [channels]);

  function flashSaved(index: number) {
    setSaveState((s) => ({ ...s, [index]: "saved" }));
    clearTimeout(savedFlashTimers.current[index]);
    savedFlashTimers.current[index] = setTimeout(() => {
      setSaveState((s) => ({ ...s, [index]: "idle" }));
    }, 1500);
  }

  async function saveLabel(index: number, label: string) {
    const trimmed = label.trim();
    const current = channels.find((c) => c.index === index);
    if (!trimmed || trimmed === current?.label) return;
    setSaveState((s) => ({ ...s, [index]: "saving" }));
    try {
      const updated = await updateChannel(index, { label: trimmed });
      onChanged(channels.map((c) => (c.index === index ? updated : c)));
      flashSaved(index);
      trackEvent("channel_configured", { field: "label" });
    } catch {
      setSaveState((s) => ({ ...s, [index]: "idle" }));
    }
  }

  async function saveKind(index: number, kind: "consumer" | "producer") {
    setSaveState((s) => ({ ...s, [index]: "saving" }));
    try {
      const updated = await updateChannel(index, { kind });
      onChanged(channels.map((c) => (c.index === index ? updated : c)));
      flashSaved(index);
      trackEvent("channel_configured", { field: "kind", value: kind });
    } catch {
      setSaveState((s) => ({ ...s, [index]: "idle" }));
    }
  }

  async function saveFactor(index: number, raw: string) {
    const current = channels.find((c) => c.index === index);
    const trimmed = raw.trim();
    const value = Number(trimmed);
    if (!trimmed || !Number.isFinite(value) || value <= 0 || value > 10) {
      setFactorError((s) => ({ ...s, [index]: "0 – 10" }));
      return;
    }
    setFactorError((s) => ({ ...s, [index]: "" }));
    if (current && value === current.factor) return;
    setSaveState((s) => ({ ...s, [index]: "saving" }));
    try {
      const updated = await updateChannel(index, { factor: value });
      onChanged(channels.map((c) => (c.index === index ? updated : c)));
      setFactors((s) => ({ ...s, [index]: String(updated.factor) }));
      flashSaved(index);
      trackEvent("channel_configured", { field: "factor" });
    } catch {
      setSaveState((s) => ({ ...s, [index]: "idle" }));
    }
  }

  return (
    <div className="card">
      <h2>Configure channels</h2>
      <p style={{ margin: "-6px 0 16px", fontSize: 12, color: "var(--text-muted)" }}>
        Rename any of the 16 circuits and mark whichever ones generate power — a CT clamp on a
        solar inverter, for example — as a <strong>producer</strong> instead of a consumer. The 3
        main phase feeds aren't a consumer or a producer — they're the grid tie — and their
        direction is derived <strong>automatically</strong>: whenever total consumer draw exceeds
        total local production, the difference is being pulled from the grid; otherwise the
        surplus is being pushed back out to it.
      </p>
      <p style={{ margin: "-6px 0 16px", fontSize: 12, color: "var(--text-muted)" }}>
        <strong>Factor</strong> multiplies just that one circuit's power/energy at ingest —
        separate from the mains-wide calibration in Power calibration below. Useful for a clamp on
        an inductive load (a compressor motor) that reads apparent power rather than true power,
        so it runs high specifically while that motor is under load in a way the mains factor
        can't fix. There's no way to derive it automatically (no reactive-power reading to compute
        a real power factor from) — it has to be tuned by hand against the household's known total
        (mains + solar) while the circuit is running. Existing history needs{" "}
        <code>rescale-channel-indexes.js</code> to match a changed factor (see README).
      </p>
      <div className="settings-list">
        {channels.map((c) => {
          const direction = reading?.gridDirection;
          return (
            <div className="settings-row" key={c.index}>
              <span className="settings-index">
                #{c.index}
                {c.type === "main" && <span className="kind-static main-tag">MAIN</span>}
              </span>
              <input
                className="settings-label-input"
                value={labels[c.index] ?? c.label}
                onFocus={() => (focusedIndex.current = c.index)}
                onChange={(e) => setLabels((s) => ({ ...s, [c.index]: e.target.value }))}
                onBlur={(e) => {
                  focusedIndex.current = null;
                  saveLabel(c.index, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
              {c.type === "main" ? (
                <span className={`auto-kind ${direction ?? ""}`}>
                  <span className="auto-dot" />
                  Auto — {direction === "importing" ? "Pulling from grid" : direction === "exporting" ? "Pushing to grid" : "…"}
                </span>
              ) : (
                <div className="kind-toggle">
                  <button
                    className={`kind-btn consumer ${c.kind === "consumer" ? "active" : ""}`}
                    onClick={() => saveKind(c.index, "consumer")}
                  >
                    Consumer
                  </button>
                  <button
                    className={`kind-btn producer ${c.kind === "producer" ? "active" : ""}`}
                    onClick={() => saveKind(c.index, "producer")}
                  >
                    Producer
                  </button>
                </div>
              )}
              {c.type === "main" ? (
                <span className="settings-factor-static" title="Mains use the calibration factor below instead">
                  —
                </span>
              ) : (
                <input
                  className={`settings-factor-input ${c.factor !== 1 ? "non-default" : ""}`}
                  type="number"
                  step="any"
                  min={0}
                  max={10}
                  value={factors[c.index] ?? String(c.factor)}
                  title={factorError[c.index] || "Multiplies this circuit's power/energy (1 = no correction)"}
                  onFocus={() => (focusedFactorIndex.current = c.index)}
                  onChange={(e) => setFactors((s) => ({ ...s, [c.index]: e.target.value }))}
                  onBlur={(e) => {
                    focusedFactorIndex.current = null;
                    saveFactor(c.index, e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              )}
              <span className={`save-flag ${saveState[c.index] ?? "idle"}`}>
                {saveState[c.index] === "saving"
                  ? "Saving…"
                  : saveState[c.index] === "saved"
                    ? "Saved"
                    : factorError[c.index]
                      ? factorError[c.index]
                      : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
