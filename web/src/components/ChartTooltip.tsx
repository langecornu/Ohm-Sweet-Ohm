interface Series {
  key: string;
  label: string;
  color: string;
  value: number;
  unit?: string;
}

export default function ChartTooltip({
  timeLabel,
  series,
}: {
  timeLabel: string;
  series: Series[];
}) {
  return (
    <div className="tooltip-box">
      <div className="t-time">{timeLabel}</div>
      {series.map((s) => (
        <div className="t-row" key={s.key}>
          <span className="dot" style={{ background: s.color }} />
          <span className="name">{s.label}</span>
          <span className="val">
            {s.value.toFixed(1)} {s.unit ?? "W"}
          </span>
        </div>
      ))}
    </div>
  );
}
