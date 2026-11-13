import { memo, useState } from "react";
import lcPositive from "../assets/lc-mark-positive.svg";
import lcReversed from "../assets/lc-mark-reversed.svg";
import Logo from "./Logo";
import { useIsDark } from "../useIsDark";

const EMAIL_USER = "francois";
const EMAIL_DOMAIN = "langecornu.com";
const LINKEDIN_URL = "https://www.linkedin.com/in/f-gravel/";

/**
 * The address is only ever assembled in JS, on click — it never sits as
 * plain text (or a `mailto:` href) in the page's initial HTML, which is
 * what most bots scrape. Not bulletproof against a headless browser
 * running real JS, but stops the common case.
 */
function EmailReveal() {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return (
      <button type="button" className="range-btn" onClick={() => setRevealed(true)}>
        Show email address
      </button>
    );
  }
  const email = `${EMAIL_USER}@${EMAIL_DOMAIN}`;
  return (
    <a href={`mailto:${email}`} className="tech-badge" style={{ textDecoration: "none" }}>
      {email}
    </a>
  );
}

// Memoized: this page takes no props and never changes once mounted, but
// without memo() it still fully re-renders every ~2s in step with the live
// WebSocket tick (App's `reading`/`rolling` state lives above it in the
// tree) — pure wasted work for a static page. See the same note on
// HowItWorks/DailySnapshots/Analytics.
function AboutPage() {
  const isDark = useIsDark();

  return (
    <>
      <div className="card">
        <h2>About this application</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
          <div className="pipeline-icon accent-series-1" style={{ width: 48, height: 48 }}>
            <Logo size={26} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Ohm Sweet Ohm</div>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>A live home energy dashboard</div>
          </div>
        </div>
        <p className="howto-lede" style={{ maxWidth: "72ch" }}>
          Ohm Sweet Ohm reads directly from a SEM Meter — 16 breaker circuits plus 3 main phases, published over{" "}
          <strong>MQTT</strong> every couple of seconds — and turns that stream into a live dashboard, historical
          slices, and rich analytics, entirely on infrastructure this app owns end to end. No vendor cloud, no
          Home Assistant required.
        </p>
        <p className="howto-lede" style={{ maxWidth: "72ch", marginTop: 12 }}>
          Every reading is stored forever in SQLite (never downsampled or expired), so the history you see today —
          today's snapshot, daily snapshots, analytics, billing-period totals — is always computed from the exact
          same raw data, just sliced a different way. The sections below walk through what's actually happening
          behind each part of the dashboard; see the <strong>How it works</strong> tab for a more visual, diagram-led
          tour of the MQTT pipeline itself (panel → meter → broker → this app).
        </p>
        <p className="howto-lede" style={{ maxWidth: "72ch", marginTop: 12 }}>
          It's also a real installable app — "Add to Home Screen" on a phone gives it its own icon and a full-screen
          window, no browser chrome, the same as any native app — and once installed it can push you a notification
          when usage runs unusually high, or a daily email recap of the day before. Neither needs the app open;
          both work in the background.
        </p>
        <div className="badge-row" style={{ marginTop: 16 }}>
          <span className="tech-badge">Node.js</span>
          <span className="tech-badge">MQTT</span>
          <span className="tech-badge">SQLite</span>
          <span className="tech-badge">React</span>
          <span className="tech-badge">TypeScript</span>
        </div>
      </div>

      <div className="card">
        <h2>What you can customize (Settings)</h2>
        <p className="chart-caption">
          Everything below lives in the admin-only Settings tab — log in once (top of the sidebar) to unlock it.
          Every visitor sees the same live/historical data either way; Settings only controls how that data is
          labeled and computed, not who can see it.
        </p>
        <div className="also-row">
          <div>
            <h3>Channel labels & kind</h3>
            <p>
              Rename any of the 16 breaker circuits and tag each one as a consumer, a solar producer, or excluded
              from totals. This drives everything downstream — which circuits count as "household load," which get
              reclassified after dark, and how Usage by circuit / heatmaps label themselves.
            </p>
          </div>
          <div>
            <h3>Weather location</h3>
            <p>
              A 5-digit US zip code resolves to a lat/lon and timezone (via Open-Meteo), which unlocks the
              temperature-correlation charts, sunrise/sunset times for the daylight switch below, and makes every
              "today" boundary in the app use your zip's actual timezone rather than the server's.
            </p>
          </div>
          <div>
            <h3>Power calibration factor</h3>
            <p>
              A single multiplier applied to the 3 main-phase readings at ingest time, before they're ever stored
              — the 16 circuit clamps are never affected by it. Defaults to 1 (no correction). See "Keeping the
              numbers honest" below for why this installation runs one.
            </p>
          </div>
          <div>
            <h3>Billing periods</h3>
            <p>
              A "day of month the cycle starts" setting (1–28) for your solar company, and your utility's actual
              meter-read dates for the electric cycle (utilities don't read on a fixed day). Daily Snapshots can
              align its month view to either cycle instead of the calendar month, so its totals line up with what's
              actually on your bills.
            </p>
          </div>
          <div>
            <h3>Usage alerts</h3>
            <p>
              An on/off switch and a threshold (5–500% above normal) for push notifications when consumption runs
              unusually high for that hour of day. The bell icon itself (sidebar footer) is separate — anyone can
              subscribe their own browser, no login needed; only the threshold and on/off switch are admin-gated.
            </p>
          </div>
          <div>
            <h3>Daily email report</h3>
            <p>
              Once turned on with an address, sent once each local day finishes: yesterday's totals,
              biggest circuit, peak consumption and production, self-consumption, a 7-day trend chart, and how this
              month compares to last month so far. A "send test email now" button in Settings previews it on demand.
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>How the temperature correlation works</h2>
        <p className="howto-lede" style={{ maxWidth: "72ch" }}>
          The Analytics tab's temperature charts compare "total consumption" — solar produced plus grid imported,
          the same real household energy balance used everywhere in this app — against outdoor temperature at the
          same moment, sourced from Open-Meteo and cached in SQLite so each hour is only ever fetched once.
        </p>
        <p className="howto-lede" style={{ maxWidth: "72ch", marginTop: 12 }}>
          Two views cover different time grains: an <strong>hourly</strong> scatter plot for whatever range is
          selected (up to 7 days), and a <strong>daily</strong> time series averaging a full 90 days, so a
          long-run heating/cooling pattern is visible even when the range picker itself tops out much shorter.
          Both report a <strong>Pearson correlation coefficient</strong> (r, from −1 to 1) between temperature and
          consumption, translated into plain English — "strongly/moderately/weakly tied to temperature," and
          whether it points to AC (more power when hotter) or heating (more power when colder) — rather than
          leaving you to interpret the statistic yourself.
        </p>
      </div>

      <div className="card">
        <h2>The daylight switch</h2>
        <p className="howto-lede" style={{ maxWidth: "72ch" }}>
          Solar panels are read through the same current clamp whether the sun is up or not. After dark, a solar
          inverter typically still draws a few watts of its own — staying powered, syncing status to the solar
          company's cloud — and without correction that draw gets misread as production, positive wattage from a
          "producer" channel with no way to distinguish it from real generation. Left alone, that double-counts:
          the draw already shows up as grid import (it has to come from somewhere), and counting it a second time
          as "produced" inflates total consumption by roughly 2x the draw.
        </p>
        <p className="howto-lede" style={{ maxWidth: "72ch", marginTop: 12 }}>
          So outside of daylight hours, producer-tagged channels contribute <strong>0</strong> to production and
          total-consumption figures — you'll see the panel's tile move from the solar side to the consumption side
          on the Live tab after sunset, with a hover explaining why. Daylight itself comes from real sunrise/sunset
          times for your zip code (Open-Meteo's astronomy data, not a fixed clock time — it shifts with the
          seasons automatically), with a 25-minute grace window on both ends so genuine dawn/dusk production at the
          margins isn't clipped.
        </p>
      </div>

      <div className="card">
        <h2>Keeping the numbers honest</h2>
        <div className="also-row">
          <div>
            <h3>The √3 calibration finding</h3>
            <p>
              This installation's mains readings ran ~1.73x too high — a 0.1% match to √3. The meter's 3 main
              channels are labeled L1/L2/L3, three-phase nomenclature, but this is a split-phase US residential
              service with only 2 legs (L3 always reads 0) — evidence points to a three-phase power formula being
              applied where it doesn't belong. Confirmed against an exact SDGE 15-minute CSV export, then corrected
              with the calibration factor above (applied at ingest, plus a one-time rescale of existing history).
              An early version applied that same correction to the 16 circuit clamps too — a second check against
              the solar company's own daily production numbers caught it: solar was reading low by close to the
              same √3, since each circuit's own clamp never goes through the mains' three-leg-combining step that
              caused the problem in the first place. The factor now applies to the 3 main channels only.
            </p>
          </div>
          <div>
            <h3>Peak-detection glitch rejection</h3>
            <p>
              This meter occasionally reports one ~2-second sample 20–30x too high while every circuit stays
              unchanged — a corrupted MQTT payload, not a real load (a real spike ramps over multiple samples and
              shows up in the circuit breakdown too). Peak-demand figures reject any single sample that's more than
              3x both of its immediate neighbors, so one bad reading can't masquerade as your biggest moment.
            </p>
          </div>
          <div>
            <h3>Timezone-aware "today"</h3>
            <p>
              "Today" always starts at 00:00 in your zip code's own timezone — not the server's, which may well run
              in a different one entirely. Today's Snapshot, Daily Snapshots, and billing-period totals all share
              this same day boundary, computed by hand (no extra dependency) against the IANA timezone database.
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>About me</h2>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
          <img
            src={isDark ? lcReversed : lcPositive}
            alt="Lange Cornu"
            width={64}
            height={73}
            style={{ flexShrink: 0 }}
          />
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 2 }}>François Gravel</div>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 12 }}>Lange Cornu — San Diego, CA</div>
            <p className="howto-lede" style={{ maxWidth: "60ch" }}>
              I built Ohm Sweet Ohm as a personal project to make sense of my own home's solar and grid usage — the
              kind of thing that starts with "I just want to see the numbers" and grows into a full dashboard with
              its own calibration findings, timezone math, and glitch detection along the way.
            </p>
            <p className="howto-lede" style={{ maxWidth: "60ch", marginTop: 10 }}>
              Outside of this project, I work under the name Lange Cornu. You can find more about me and my other
              work at{" "}
              <a href="https://langecornu.com" target="_blank" rel="noreferrer noopener">
                langecornu.com
              </a>
              , connect on{" "}
              <a href={LINKEDIN_URL} target="_blank" rel="noreferrer noopener">
                LinkedIn
              </a>
              , or reach out directly:
            </p>
            <div style={{ marginTop: 10 }}>
              <EmailReveal />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default memo(AboutPage);
