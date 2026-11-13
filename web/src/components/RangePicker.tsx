import { useState } from "react";
import { trackEvent } from "../analytics";

export interface Range {
  from: number;
  to: number;
  label: string;
}

const PRESETS: { label: string; ms: number }[] = [
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
];

function toLocalInputValue(ts: number) {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

export default function RangePicker({
  range,
  onChange,
  context = "unknown",
}: {
  range: Range;
  onChange: (r: Range) => void;
  /** which view this picker lives in, e.g. "slice_of_time" — tagged onto the analytics event */
  context?: string;
}) {
  const [activePreset, setActivePreset] = useState(range.label);
  const [customFrom, setCustomFrom] = useState(toLocalInputValue(range.from));
  const [customTo, setCustomTo] = useState(toLocalInputValue(range.to));

  function applyPreset(label: string, ms: number) {
    const to = Date.now();
    const from = to - ms;
    setActivePreset(label);
    setCustomFrom(toLocalInputValue(from));
    setCustomTo(toLocalInputValue(to));
    trackEvent("time_range_select", { range_label: label, context });
    onChange({ from, to, label });
  }

  function applyCustom() {
    const from = new Date(customFrom).getTime();
    const to = new Date(customTo).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return;
    setActivePreset("custom");
    trackEvent("time_range_select", { range_label: "custom", context });
    onChange({ from, to, label: "custom" });
  }

  return (
    <div className="range-bar">
      {PRESETS.map((p) => (
        <button
          key={p.label}
          className={`range-btn ${activePreset === p.label ? "active" : ""}`}
          onClick={() => applyPreset(p.label, p.ms)}
        >
          Last {p.label}
        </button>
      ))}
      <div className="range-custom">
        <input type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
        <span>→</span>
        <input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
        <button className="range-btn" onClick={applyCustom}>
          Apply
        </button>
      </div>
    </div>
  );
}
