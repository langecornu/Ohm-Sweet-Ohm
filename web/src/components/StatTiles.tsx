import type { LiveReading } from "../types";

function fmt(n: number, digits = 1) {
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export default function StatTiles({ reading }: { reading: LiveReading | null }) {
  const power = reading?.totalPower ?? 0;
  const current = reading?.totalCurrent ?? 0;
  const voltage = reading?.avgVoltage ?? 0;
  const net = (reading?.totalEnergyIn ?? 0) - (reading?.totalEnergyOut ?? 0);
  // Tile visibility uses the *configured* kind (stays visible after dark);
  // the summed value uses the *effective* kind, which is 0 once every
  // producer channel has flipped to "consumer" for the night — see
  // ChannelReading.reclassifiedAtNight / channelConfig.js.
  const configuredProducers = reading?.channels.filter((c) => (c.configuredKind ?? c.kind) === "producer") ?? [];
  const producingNow = reading?.channels.filter((c) => c.kind === "producer") ?? [];
  const production = producingNow.reduce((s, c) => s + c.power, 0);
  const exporting = reading?.gridDirection === "exporting";

  return (
    <div className="hero-row">
      <div className="stat-tile hero">
        <div className="label">Grid power</div>
        <div className="value" style={exporting ? { color: "var(--series-3)" } : undefined}>
          {reading ? fmt(power) : "—"}
          <span className="unit">W</span>
        </div>
        <div className="sub">{reading ? (exporting ? "pushing to grid, live" : "pulling from grid, live") : "sum of 3 main phases, live"}</div>
      </div>
      {configuredProducers.length > 0 && (
        <div className="stat-tile">
          <div className="label">Solar production</div>
          <div className="value" style={{ color: producingNow.length > 0 ? "var(--series-3)" : undefined }}>
            {fmt(production)}
            <span className="unit">W</span>
          </div>
          <div className="sub">
            {configuredProducers.length} channel{configuredProducers.length > 1 ? "s" : ""} marked producer
            {producingNow.length === 0 ? " · sun's down" : ""}
          </div>
        </div>
      )}
      <div className="stat-tile">
        <div className="label">Total current</div>
        <div className="value">
          {reading ? fmt(current, 2) : "—"}
          <span className="unit">A</span>
        </div>
      </div>
      <div className="stat-tile">
        <div className="label">Avg. voltage</div>
        <div className="value">
          {reading ? fmt(voltage) : "—"}
          <span className="unit">V</span>
        </div>
      </div>
      <div className="stat-tile">
        <div className="label">Lifetime net energy</div>
        <div className="value">
          {reading ? fmt(net, 1) : "—"}
          <span className="unit">kWh</span>
        </div>
        <div className="sub">import − export, since meter install (Oct 1, 2025)</div>
      </div>
    </div>
  );
}
