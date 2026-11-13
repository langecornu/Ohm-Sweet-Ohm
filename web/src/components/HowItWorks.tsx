// A tour of the data pipeline: breaker panel -> MQTT -> this dashboard.
// Pure presentational page — no data fetching, just diagrams + explanation.
// Wrapped in memo() (see AboutPage.tsx) — it never changes once mounted, so
// there's no reason for it to re-render on every ~2s live-socket tick.
import { Fragment, memo, type ReactElement } from "react";
import settingsScreenshot from "../assets/howto-settings-daily-email.png";
import emailScreenshot from "../assets/howto-daily-email-preview.png";

const ICON_PATHS: Record<string, ReactElement> = {
  meter: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <line x1="8" y1="7" x2="8" y2="11.5" />
      <line x1="12" y1="7" x2="12" y2="11.5" />
      <line x1="16" y1="7" x2="16" y2="11.5" />
      <line x1="7" y1="15.5" x2="17" y2="15.5" />
      <line x1="7" y1="18.5" x2="13" y2="18.5" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <path d="M8.4 8.4a5 5 0 0 0 0 7.2" />
      <path d="M15.6 8.4a5 5 0 0 1 0 7.2" />
      <path d="M5.6 5.6a9 9 0 0 0 0 12.8" />
      <path d="M18.4 5.6a9 9 0 0 1 0 12.8" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="16" height="6.5" rx="1.5" />
      <circle cx="7.5" cy="7.25" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="16.75" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
      <path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" />
    </>
  ),
  bolt: <path d="M13 2 5 13.5h6l-1 8.5 8-11.5h-6l1-8.5Z" strokeLinejoin="round" />,
  browser: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <line x1="3" y1="8.5" x2="21" y2="8.5" />
      <circle cx="6.2" cy="6.5" r="0.65" fill="currentColor" stroke="none" />
      <circle cx="8.6" cy="6.5" r="0.65" fill="currentColor" stroke="none" />
    </>
  ),
  cloud: <path d="M7.2 18a4.2 4.2 0 0 1-.6-8.35A5.2 5.2 0 0 1 16.4 8.9a4.6 4.6 0 0 1 .6 9.1H7.2Z" />,
  tag: (
    <>
      <path d="M11 3H5a2 2 0 0 0-2 2v6l9.6 9.6a2 2 0 0 0 2.83 0l6.17-6.17a2 2 0 0 0 0-2.83L12 3Z" />
      <circle cx="7.5" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  calc: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <line x1="8" y1="7" x2="16" y2="7" />
      <circle cx="8.3" cy="11.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="15.7" cy="11.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="8.3" cy="15" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="15" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="15.7" cy="15" r="0.8" fill="currentColor" stroke="none" />
      <line x1="8" y1="18.3" x2="16" y2="18.3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.3 2" />
    </>
  ),
  clamp: (
    <>
      <path d="M12 4.5a7.5 7.5 0 1 0 6.5 11.3" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="21" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  wave: <path d="M2.5 12c1.4-5.5 2.9-5.5 4.3 0s2.9 5.5 4.3 0 2.9-5.5 4.3 0 2.9 5.5 4.3 0" />,
  multiply: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </>
  ),
  grow: (
    <>
      <line x1="4" y1="20" x2="4" y2="14" />
      <line x1="10" y1="20" x2="10" y2="9" />
      <line x1="16" y1="20" x2="16" y2="6" />
      <path d="M3 21h18" />
    </>
  ),
  panel: (
    <>
      <rect x="5" y="2.5" width="14" height="19" rx="1.5" />
      <line x1="5" y1="7" x2="19" y2="7" />
      <line x1="8.5" y1="10" x2="8.5" y2="18" />
      <line x1="12" y1="10" x2="12" y2="18" />
      <line x1="15.5" y1="10" x2="15.5" y2="18" />
    </>
  ),
  wifi: (
    <>
      <path d="M4.5 9.5a11 11 0 0 1 15 0" />
      <path d="M7.5 13a7 7 0 0 1 9 0" />
      <path d="M10.5 16.3a3 3 0 0 1 3 0" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 6.5 12 13 20.5 6.5" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <line x1="10.5" y1="19" x2="13.5" y2="19" />
    </>
  ),
  bell: (
    <>
      <path d="M6 10.5a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 14.5 6 10.5Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
};

function Icon({ name }: { name: keyof typeof ICON_PATHS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      {ICON_PATHS[name]}
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

interface PipeNode {
  icon: keyof typeof ICON_PATHS;
  accent: "series-1" | "series-2" | "series-3" | "series-4";
  title: string;
  desc: string;
}

const PIPELINE: PipeNode[] = [
  { icon: "meter", accent: "series-1", title: "SEM Meter", desc: "16 breaker CTs + 3 main phases, sampled in the panel." },
  { icon: "broadcast", accent: "series-4", title: "MQTT broker", desc: "mqtt001.tumblevd.com — the meter publishes, nothing polls it." },
  { icon: "server", accent: "series-2", title: "Node.js backend", desc: "Subscribes, decodes, scales, and tags every reading." },
  { icon: "database", accent: "series-3", title: "SQLite", desc: "Every raw reading kept, forever, on local disk." },
  { icon: "bolt", accent: "series-4", title: "WebSocket", desc: "Same reading pushed to every open browser tab, instantly." },
  { icon: "browser", accent: "series-1", title: "This dashboard", desc: "Live tiles, history slices, analytics — all from the row above." },
];

const SENSING: PipeNode[] = [
  { icon: "clamp", accent: "series-1", title: "CT clamp", desc: "A split-core clamp rings each circuit's wire and senses its current without ever cutting in." },
  { icon: "wave", accent: "series-4", title: "Voltage reference", desc: "The 3 main-phase taps give the meter a live voltage waveform to pair with every clamp." },
  { icon: "multiply", accent: "series-2", title: "P = V × I", desc: "Instantaneous voltage × current is computed continuously, per channel, in real power (W)." },
  { icon: "grow", accent: "series-3", title: "Integrated over time", desc: "Power is summed moment to moment into the cumulative energyIn / energyOut counters." },
];

function PipelineRow({ nodes }: { nodes: PipeNode[] }) {
  return (
    <div className="pipeline">
      {nodes.map((node, i) => (
        <Fragment key={node.title}>
          <div className="pipeline-node">
            <div className={`pipeline-icon accent-${node.accent}`}>
              <Icon name={node.icon} />
            </div>
            <h3>{node.title}</h3>
            <p>{node.desc}</p>
          </div>
          {i < nodes.length - 1 && (
            <div className="pipeline-arrow">
              <ArrowIcon />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

interface StepItem {
  icon: keyof typeof ICON_PATHS;
  title: string;
  desc: string;
}

const STEPS: StepItem[] = [
  { icon: "calc", title: "Decode & scale", desc: "19 raw number rows become volts, amps, watts and kWh using the meter's fixed scale factors." },
  { icon: "tag", title: "Tag each channel", desc: "Every channel index is matched against its saved label — circuit, producer (solar), or grid — from settings." },
  { icon: "server", title: "Compute totals", desc: "Grid power comes from the 3 main-phase rows (signed: + importing, − exporting); solar comes from producer-tagged rows." },
  { icon: "bolt", title: "Store & broadcast", desc: "The reading is inserted into SQLite and pushed over WebSocket in the same tick — nothing waits on the other." },
  { icon: "clock", title: "Roll up on day change", desc: "The moment a reading crosses midnight, the prior day is cached (daily_stats, daily_snapshots) and, if enabled, a recap email goes out. Same lazy detection each time — no cron job involved." },
];

const CHANNEL_STRIP = Array.from({ length: 19 }, (_, i) => ({
  index: i,
  isMain: i >= 16,
}));

function HowItWorks() {
  return (
    <>
      <div className="card howto-hero">
        <h2>How it works</h2>
        <p className="howto-lede">
          Everything on this dashboard traces back to one thing: a SEM Meter clipped onto 16 breakers and 3 main
          phases in the panel, publishing a fresh reading over <strong>MQTT</strong> roughly every couple of seconds.
          No polling, no cloud API — the meter pushes, and this app just listens.
        </p>
      </div>

      <div className="card">
        <h2>Inside the panel</h2>
        <p className="chart-caption">
          The meter itself is one small unit wired to the breaker panel — no per-circuit hardware to install, no
          cutting into any wire.
        </p>

        <div className="also-row" style={{ marginBottom: 22 }}>
          <div className="also-item">
            <div className="pipeline-icon accent-series-1">
              <Icon name="panel" />
            </div>
            <div>
              <h3>16 + 3 channels</h3>
              <p>
                16 split-core clamps ring individual breaker wires for per-circuit visibility, plus 3 more on the
                main feed lugs — the same 3 rows Home Assistant's own tutorial sums into a "MAIN" sensor, and what
                this dashboard uses as the ground-truth grid reading.
              </p>
            </div>
          </div>
          <div className="also-item">
            <div className="pipeline-icon accent-series-4">
              <Icon name="wifi" />
            </div>
            <div>
              <h3>WiFi, not wired networking</h3>
              <p>
                The meter joins your WiFi and phones home over MQTT. Out of the box that's the vendor's own cloud
                broker under an account (email/password, or an Apple/Google quick-login with a default password of{" "}
                <code>semmeter</code>) — but, per its own setup guide, it can be repointed at any MQTT broker
                instead. This dashboard runs its own, so the meter's readings go straight here, no vendor cloud or
                Home Assistant required.
              </p>
            </div>
          </div>
        </div>

        <p className="chart-caption">How one clamp becomes a wattage, continuously:</p>
        <PipelineRow nodes={SENSING} />
      </div>

      <div className="card">
        <h2>The pipeline</h2>
        <p className="chart-caption">From breaker panel to browser tab, in six hops.</p>
        <PipelineRow nodes={PIPELINE} />
      </div>

      <div className="card">
        <h2>Inside one MQTT message</h2>
        <p className="chart-caption">
          The meter publishes to a topic keyed by its own serial number, so multiple meters could share one broker
          without colliding. This backend subscribes with a wildcard and decodes whatever arrives.
        </p>

        <div className="payload-mock">
          <div className="payload-topic">
            <span className="payload-topic-label">topic</span>
            SEMMETER/XXXXXXXXXXXX/HA
          </div>
          <pre className="payload-json">{`{
  "sense": [
    [1214, 382, 46370, 128402, 0],      // 0  circuit — raw units
    [1213, 0,   0,     0,      0],      // 1  circuit
    [1215, 891, 108530, 542190, 0],     // …
    [1219, 45,  5490,  91031,  0],      // 15 circuit — last of 16
    [2441, 1780, 434700, 982050, 43120],// 16 main L1
    [2439, 1652, 402990, 861200, 51900],// 17 main L2
    [2440, 1288, 314260, 705880, 38010] // 18 main L3
  ]
}`}</pre>
        </div>

        <div className="payload-legend">
          <div className="scale-table">
            <div className="scale-row-h">
              <span>field</span>
              <span>scale</span>
              <span>unit</span>
            </div>
            <div className="scale-row">
              <span>voltage</span>
              <span>× 0.1</span>
              <span>V</span>
            </div>
            <div className="scale-row">
              <span>current</span>
              <span>× 0.01</span>
              <span>A</span>
            </div>
            <div className="scale-row">
              <span>power</span>
              <span>× 0.01</span>
              <span>W</span>
            </div>
            <div className="scale-row">
              <span>energy in/out</span>
              <span>× 0.001</span>
              <span>kWh (cumulative)</span>
            </div>
          </div>

          <div className="channel-strip-wrap">
            <div className="channel-strip">
              {CHANNEL_STRIP.map((c) => (
                <div key={c.index} className={`strip-chip ${c.isMain ? "main" : "circuit"}`} title={c.isMain ? `Main phase row ${c.index}` : `Circuit row ${c.index}`}>
                  {c.index}
                </div>
              ))}
            </div>
            <div className="legend-row" style={{ marginTop: 8 }}>
              <div className="legend-item">
                <span className="swatch" style={{ background: "var(--series-1)" }} />
                16 circuit breakers (0–15)
              </div>
              <div className="legend-item">
                <span className="swatch" style={{ background: "var(--series-4)" }} />
                3 main phases (16–18)
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>From message to meaning</h2>
        <p className="chart-caption">What the backend does with every reading the instant it arrives.</p>
        <div className="step-flow">
          {STEPS.map((step, i) => (
            <div className="step-flow-item" key={step.title}>
              <div className="step-flow-marker">
                <div className="step-flow-icon">
                  <Icon name={step.icon} />
                </div>
                {i < STEPS.length - 1 && <div className="step-flow-line" />}
              </div>
              <div className="step-flow-body">
                <h3>{step.title}</h3>
                <p>{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Staying in the loop</h2>
        <p className="chart-caption">
          Three ways to hear from the dashboard without having it open — none of them need a server-side scheduler,
          all three key off the same reading stream and calendar-day detection everything else here uses.
        </p>
        <div className="also-row">
          <div className="also-item">
            <div className="pipeline-icon accent-series-1">
              <Icon name="phone" />
            </div>
            <div>
              <h3>Install it as an app</h3>
              <p>
                It's a PWA (manifest + service worker) — "Add to Home Screen" on a phone, or the install prompt on
                desktop, gives it a real icon and its own window, no browser chrome. That's also what makes the two
                notification paths below possible: push notifications only work from an installed/subscribed app
                context, not a random tab.
              </p>
            </div>
          </div>
          <div className="also-item">
            <div className="pipeline-icon accent-series-4">
              <Icon name="bell" />
            </div>
            <div>
              <h3>Push notification on a usage spike</h3>
              <p>
                The bell icon subscribes that device (Web Push/VAPID) — no login needed, it's per-device. A
                background check every 5 minutes compares a smoothed 15-minute average against the historical
                average for that hour of day over the trailing 28 days; if it's admin-configured threshold% over,
                every subscribed device gets a push, at most once per 2 hours.
              </p>
            </div>
          </div>
          <div className="also-item">
            <div className="pipeline-icon accent-series-3">
              <Icon name="mail" />
            </div>
            <div>
              <h3>Daily email recap</h3>
              <p>
                On by default, to one admin-configured address. The instant a local day's last reading lands and
                the next one is tagged with a new date, that finished day is cached (daily_snapshots) and its recap
                — totals, biggest circuit, peak consumption/production, self-consumption, a 7-day trend chart,
                month-vs-last-month — is emailed out. A "send test now" button in Settings previews it without
                waiting for midnight.
              </p>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
          <p className="chart-caption" style={{ marginBottom: 14 }}>
            See it in action — the Settings card that controls it, and the email itself:
          </p>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
            <figure style={{ margin: 0, flex: "1 1 380px", maxWidth: 480 }}>
              <img
                src={settingsScreenshot}
                alt="Daily email report settings card, with the enabled toggle, recipient address field, and a Send test email now button"
                style={{ width: "100%", height: "auto", display: "block", borderRadius: 10, border: "1px solid var(--border)" }}
              />
              <figcaption style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8, textAlign: "center" }}>
                Settings → Daily email report
              </figcaption>
            </figure>
            <figure style={{ margin: 0, flex: "1 1 260px", maxWidth: 300 }}>
              <img
                src={emailScreenshot}
                alt="The rendered daily email report, showing produced/pulled from grid/total stat tiles, a 7-day trend bar chart, and notable facts about the day"
                style={{ width: "100%", height: "auto", display: "block", borderRadius: 10, border: "1px solid var(--border)" }}
              />
              <figcaption style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8, textAlign: "center" }}>
                The email itself
              </figcaption>
            </figure>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Also feeding the dashboard</h2>
        <div className="also-row">
          <div className="also-item">
            <div className="pipeline-icon accent-series-3">
              <Icon name="cloud" />
            </div>
            <div>
              <h3>Outdoor temperature</h3>
              <p>Your zip code resolves to a lat/lon (Zippopotam.us), then hourly history comes from Open-Meteo — both free, no key, cached in SQLite so each hour is fetched once, ever.</p>
            </div>
          </div>
          <div className="also-item">
            <div className="pipeline-icon accent-series-2">
              <Icon name="tag" />
            </div>
            <div>
              <h3>Channel labels</h3>
              <p>Circuit names and their circuit / producer / grid tags live in the same database — set once in Settings, applied to every reading from then on.</p>
            </div>
          </div>
        </div>
        <div className="badge-row">
          <span className="tech-badge">Node.js</span>
          <span className="tech-badge">MQTT</span>
          <span className="tech-badge">WebSocket</span>
          <span className="tech-badge">SQLite</span>
          <span className="tech-badge">React</span>
        </div>
      </div>
    </>
  );
}

export default memo(HowItWorks);
