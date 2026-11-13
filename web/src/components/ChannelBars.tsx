import type { ChannelReading, LiveReading } from "../types";

function barClass(c: ChannelReading) {
  if (c.kind === "producer") return "producer";
  if (c.kind === "grid") return "grid";
  return "";
}

function Rows({
  channels,
  maxPower,
  onSelect,
}: {
  channels: ChannelReading[];
  maxPower: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <div className="channel-list">
      {channels.map((c) => {
        const clickable = c.type === "circuit" && onSelect;
        return (
          <div
            className={`channel-row ${clickable ? "clickable" : ""}`}
            key={c.index}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? () => onSelect!(c.index) : undefined}
            onKeyDown={
              clickable
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") onSelect!(c.index);
                  }
                : undefined
            }
            title={
              c.reclassifiedAtNight
                ? "Configured as a producer, but it's night — the panel isn't generating, this is just its own standby draw (staying powered, syncing status), so it's counted as consumption right now."
                : undefined
            }
          >
            <div className={`name ${c.kind === "grid" ? "main" : ""}`}>
              {c.label}
              {c.reclassifiedAtNight && <span className="night-badge">🌙</span>}
            </div>
            <div className="bar-track">
              <div
                className={`bar-fill ${barClass(c)}`}
                style={{ width: `${Math.max(2, (Math.abs(c.power) / maxPower) * 100)}%` }}
              />
            </div>
            <div className="val">{c.power.toFixed(1)} W</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Power flowing through the mains but not attributable to any of the 16
 * monitored circuit clamps — i.e. `(solar produced + net grid power) - (sum
 * of consumer-tagged circuits)`. Can run either direction: positive means
 * circuits under-account for the household total (a breaker not on any
 * clamp, if the panel has more than 16; a clamp reading low), negative
 * means circuits over-account for it (a clamp reading high, or one circuit
 * effectively double-counting another — e.g. a subpanel feed plus that
 * subpanel's own downstream breakers, if both happen to be clamped). Small
 * values in either direction are normal per-channel sampling noise (each
 * clamp is read at a very slightly different instant); only shown once
 * it's large enough, and persistent enough, to be a real gap rather than
 * momentary noise. Leaving a real gap silently unlabeled reads as a bug
 * even when it isn't one, so it's surfaced explicitly instead of just
 * being missing.
 *
 * Uses the *signed* `reading.totalPower` (positive importing, negative
 * exporting) rather than flooring it at zero. Consumption = Production +
 * NetGridPower always holds, including while exporting — a floor-at-zero
 * version would drop the exported amount from the identity and inflate
 * this figure by roughly the export size any time solar output exceeds
 * the household load, which is exactly backwards: that's exported power
 * leaving the house, not power hiding on some unclamped circuit.
 */
const UNMONITORED_THRESHOLD_W = 15;

export default function ChannelBars({
  reading,
  onSelect,
}: {
  reading: LiveReading | null;
  onSelect?: (index: number) => void;
}) {
  if (!reading) return <div className="empty-state">Waiting for live data…</div>;

  const producers = reading.channels.filter((c) => c.kind === "producer").sort((a, b) => b.power - a.power);
  const grid = reading.channels.filter((c) => c.kind === "grid").sort((a, b) => b.power - a.power);
  const consumers = reading.channels.filter((c) => c.kind === "consumer").sort((a, b) => b.power - a.power);
  const importing = reading.gridDirection === "importing";

  const producedTotal = producers.reduce((s, c) => s + c.power, 0);
  const consumedTotal = consumers.reduce((s, c) => s + c.power, 0);
  const householdTotal = producedTotal + reading.totalPower;
  const unmonitored = householdTotal - consumedTotal;
  const showUnaccountedFor = unmonitored > UNMONITORED_THRESHOLD_W; // circuits under-total the household
  const showOverAccountedFor = unmonitored < -UNMONITORED_THRESHOLD_W; // circuits over-total it

  const maxPower = Math.max(
    1,
    showUnaccountedFor || showOverAccountedFor ? Math.abs(unmonitored) : 0,
    ...reading.channels.map((c) => Math.abs(c.power))
  );

  return (
    <>
      <div className="legend-row" style={{ marginBottom: 12 }}>
        <div className="legend-item">
          <span className="swatch" style={{ background: "var(--series-1)" }} />
          Circuit
        </div>
        {producers.length > 0 && (
          <div className="legend-item">
            <span className="swatch" style={{ background: "var(--series-3)" }} />
            Producer (e.g. solar)
          </div>
        )}
        <div className="legend-item">
          <span className="swatch" style={{ background: "var(--series-4)" }} />
          Grid
        </div>
      </div>

      {producers.length > 0 && (
        <>
          <div className="channel-group-title">Production</div>
          <Rows channels={producers} maxPower={maxPower} onSelect={onSelect} />
        </>
      )}

      <div className="channel-group-title">Grid</div>
      <div className={`grid-direction ${reading.gridDirection}`}>
        <span className="grid-arrow">{importing ? "↓" : "↑"}</span>
        {importing ? "Pulling" : "Pushing"} {Math.abs(reading.totalPower).toFixed(1)} W{" "}
        {importing ? "from" : "to"} the grid
      </div>
      <Rows channels={grid} maxPower={maxPower} />

      <div className="channel-group-title">Consumption</div>
      <Rows channels={consumers} maxPower={maxPower} onSelect={onSelect} />
      {(showUnaccountedFor || showOverAccountedFor) && (
        <div className="channel-list">
          <div
            className="channel-row"
            title={
              showUnaccountedFor
                ? "Solar produced + grid imported, minus the sum of the 16 monitored circuit clamps. If this doesn't settle near zero, either something's drawing power outside those 16, or one of the readings needs a closer look."
                : "The sum of the 16 monitored circuit clamps is higher than solar produced + grid imported. Worth a closer look at whichever circuit is largest right now — a clamp reading high, or two circuits double-counting the same load (e.g. a subpanel feed plus its own downstream breakers)."
            }
          >
            <div className="name" style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
              {showUnaccountedFor ? "Unaccounted power" : "Circuits over-total mains"}
            </div>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{ width: `${Math.max(2, (Math.abs(unmonitored) / maxPower) * 100)}%`, background: "var(--gridline)" }}
              />
            </div>
            <div className="val" style={{ color: "var(--text-muted)" }}>
              ~{Math.abs(unmonitored).toFixed(0)} W
            </div>
          </div>
        </div>
      )}
    </>
  );
}
