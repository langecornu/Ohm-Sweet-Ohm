# Ohm Sweet Ohm: technical notes

Implementation details, calibration history and operations notes. For setup and usage, see the [main README](../README.md).

A live power-consumption dashboard for the SEM Meter, built from the MQTT
integration documented in the vendor's
[Home Assistant tutorial](https://vs.tumblevd.com/SEM/homeasistant.html). Two pieces:

- **`server/`** — a small Node service that connects to the SEM cloud MQTT
  broker, decodes the meter's `sense` payload into real units, keeps a
  rolling history on disk, and re-serves it over REST + WebSocket.
- **`web/`** — a React (Vite) dashboard with four views:
  - **Live** — current draw, per-channel breakdown split into
    Production/Grid/Consumption, rolling chart. Click any circuit to drill
    into its own live + slice-of-time view.
  - **Slice of time** — pick any window (15m–7d or custom) and chart/tabulate
    it, optionally comparing up to 3 circuits against the total.
  - **Analytics** — usage by circuit (kWh + share of total), a heatmap of
    which circuit draws most by hour of day, average grid direction by hour
    of day (when you typically import vs export), typical load by day of
    week, grid import/export by week, consumption vs. outdoor temperature
    (see Weather correlation below), and notable metrics: peak demand,
    standby/baseline load, most-cycling circuits, and solar self-consumption.
  - **Settings** — rename any of the 19 channels and mark any circuit as a
    **producer** (e.g. a CT clamp on a solar inverter) instead of a consumer.
    The 3 main phases aren't manually classified — they show automatically
    whether the household is currently pulling from or pushing to the grid,
    based on whether configured consumer draw exceeds configured production.
    Also sets the zip code used for weather correlation. Only visible while
    logged in as admin — see Admin login below.

Credentials live in the repo-root `.env` (template: [`deploy/env.example`](../deploy/env.example)) (`SEMMETER_USER`,
`SEMMETER_PASS`, `DEVICE_SN`) — the same file used by
[`validate_semmeter_mqtt.py`](../validate_semmeter_mqtt.py).

## Run it

Two processes, two terminals:

```bash
cd server && npm install && npm start
```

```bash
cd web && npm install && npm run dev
```

Then open the URL Vite prints (`http://localhost:5173`). The dev server
proxies `/api` and `/ws` to the backend on port 8787, so both must be running.

## How the data maps

Confirmed against a live capture on `mqtt001.tumblevd.com:6000`, topic
`SEMMETER/<DEVICE_SN>/HA`:

```
payload.sense = [ [voltage, current, power, energyIn, energyOut], ... 19 rows ]

row 0–15   → 16 individually monitored breaker/circuit channels
row 16–18  → 3 "MAIN" phase feeds (L1/L2/L3) — summed for whole-panel totals

scale factors: voltage ×0.1 (V), current ×0.01 (A), power ×0.01 (W),
energyIn/energyOut ×0.001 (kWh, cumulative lifetime counters)
```

This lives in [`server/src/channels.js`](../server/src/channels.js). Circuits
are labeled generically ("Circuit 1"…"Circuit 16") since the meter doesn't
transmit human names — edit `channelLabel()` there if you know what's on each
breaker.

## Known data quirk

The meter's cumulative `energyIn`/`energyOut` counters update in coarse,
infrequent steps on this device (observed: no movement over several minutes
even at 400–700W draw). The "Energy imported" stat in Slice of time is an
exact delta of that counter, so **short windows will often read 0.00 kWh**
even while power is clearly flowing — that's the real device behavior, not a
bug. It becomes meaningful over longer ranges (hours+).

## Power calibration

This installation's **main-phase** power/energy readings measured ~1.73x
(≈√3) too high against the utility's own meter. Confirmed precisely: an
exact SDGE 15-minute CSV export (Aug 28, 11:30am–midnight) showed 26.115
kWh pulled from the grid; this app, for the identical window, showed
45.190 kWh — a ratio of 1.7304, a 0.1% match to √3 = 1.7321.

That's not a coincidence-shaped number. It's the classic signature of a
**three-phase power formula applied to a split-phase installation**: the
device labels its 3 main-phase channels `L1`/`L2`/`L3` — three-phase
nomenclature — but a US residence runs split-phase (two 120V legs, no
third phase), and sure enough `L3` has always read 0W on this install.
Three-phase power calculations involve a √3 term that a straight
split-phase sum (`P = P_L1 + P_L2`, which is what
[`channels.js`](../server/src/channels.js) already does) doesn't need — so
the extra √3 most likely comes from the device's own per-channel power
calculation, before the value ever reaches this app.

**Mains only — not the 16 circuits.** The first version of this fix
applied the correction factor to every channel, circuits included. That
was wrong, and a second round of validation caught it: two full days of
this installation's own solar production, checked against the solar
company's own daily production numbers for those same two days (Aug 29:
34.4 kWh real vs. 18.29 kWh here; Aug 30: 34.9 kWh real vs. 19.20 kWh
here), were low by close to that same √3 — meaning the 16 individually-
clamped circuits had been *over*-corrected by a bug that was never
theirs. The three-phase-formula mechanism above is specifically about how
the firmware *combines* three main-leg readings into one; a single
circuit's own clamp never goes through that combination step, so it was
never affected by that bug in the first place. [`channels.js`](../server/src/channels.js)
now applies the calibration factor only to the 3 main channels — circuits
are always their raw scaled value. Re-checked after the fix: 31.67 kWh
and 33.25 kWh against Sunrun's 34.4/34.9 — within 5–9%, in line with
ordinary CT-clamp tolerance rather than a systematic error.

This also explains part of what the Live tab's "Unaccounted power" row
was picking up (see "Keeping the numbers honest" below): under-reported
circuits meant less of the household's real total could be correctly
attributed to a named circuit, inflating that residual.

**The fix**: [`server/src/calibration.js`](../server/src/calibration.js) — a
single multiplicative factor (admin-editable in Settings, no redeploy
needed), applied only to the 3 main channels in
[`parseSensePayload()`](../server/src/channels.js) as each MQTT message is
decoded. Voltage and current are left untouched everywhere — both
independently looked physically plausible on their own; it's specifically
the derived power value that was off, and only for the channels that
actually need it. Current value: **1/√3 ≈ 0.57735**.

New readings pick up a changed factor immediately (no restart). Existing
history does **not** — it was already stored at the old scale — so
changing the factor needs a one-time rewrite of the `readings` table to
match. Two separate scripts, since mains and circuits went through two
separate corrections:

```bash
# from server/, with the app stopped (avoids racing live inserts)

# Mains-only rescale (run once, when the mains-side factor was first set):
node scripts/rescale-readings.js 0.5773502691896258
# NOTE: as originally written this script rescaled every channel,
# mains and circuits alike — that's what made the circuit-side fix
# below necessary. If you're setting up fresh today, only run this
# for a genuine mains-only calibration change.

# Circuit-only undo (run once, to correct history that had the mains
# factor wrongly applied to circuits too):
node scripts/rescale-circuit-readings.js 1.7320508075688772
```

Both scripts clear `daily_stats` and `daily_snapshots` (the day-rollup
caches) so they recompute from the now-corrected raw data. If your own
installation doesn't have this same "no third phase" hardware/wiring
pattern, this specific factor almost certainly doesn't apply to you —
leave it at the default `1` and calibrate against your own utility bill
(and, if you have solar, your solar company's own production numbers) if
needed.

### Per-circuit factors

The mains-wide factor above fixes one specific firmware quirk; it doesn't
help when a single *circuit's* own clamp reads high for an unrelated
reason. This install's Live tab showed a persistent negative "circuits
over-total mains" gap (~4–13 kWh/day) that traced, by checking which
circuits were drawing power during every gap sample, overwhelmingly to the
**Aircon** circuit specifically (73–85% of gap moments, against only a
17–30% baseline run rate — the pool pump's Garage circuit, by contrast,
showed up at close to its own baseline rate and isn't a real driver). The
likely mechanism: a compressor motor is an inductive load with a power
factor well below 1, and if that clamp reports apparent power (V×I)
rather than true power (V×I×cosθ), its wattage reads inflated specifically
while the compressor is under load — not something a single mains-wide
multiplier can correct.

Each circuit can now carry its own independent calibration factor, set in
Settings → Configure channels (`web/src/components/ChannelSettings.tsx`,
backed by `factor` in `channelConfig.js`'s per-channel overrides —
separate storage from the mains-wide factor above, and never applied to
the 3 main channels themselves). There's no way to derive it structurally
the way the mains factor was (no reactive-power reading to compute a real
power factor from), so it's fit empirically: for samples where a circuit
is running, solve `factor = 1 + (unaccounted / circuit power)` and take a
robust central estimate — an **energy-weighted** solve (using each day's
integrated kWh rather than a per-sample ratio median, which is skewed by
noisy low-power samples) fit this install's Aircon circuit at **0.73**,
cutting the daily net mismatch roughly in half to two-thirds. Real-world
power factor varies with compressor operating state, so a single fixed
value is an approximation, not an exact fit — expect to revisit it as more
data comes in.

New readings pick up a changed per-circuit factor immediately; existing
history needs the same kind of one-time rewrite as above, scoped to just
the affected index(es):

```bash
node scripts/rescale-channel-indexes.js 0.73 2 3   # Aircon Phase 1/2
```

### The mains factor only applies while importing

The 3 main channels only ever report an unsigned magnitude — import vs.
export direction isn't measured from the mains at all, it's inferred in
[`index.js`'s `withGridDirection()`](../server/src/index.js) from the 16
*circuits'* own production/consumption balance (see
[`decorateChannels()`](../server/src/channelConfig.js)). The mains
calibration factor above was derived and validated against import-
direction data only (the original SDGE comparison happened to land on an
import-heavy window). A direct comparison against **four independent,
fully-settled** SDGE 15-minute CSV exports (Aug 29 – Sep 1) told a
different story once broken out by direction:

| Date | Import diff | Export diff |
|---|---|---|
| Aug 29 | −1.5% | **−44.1%** |
| Aug 30 | +12.3% | **−41.9%** |
| Aug 31 | +3.9% | **−46.1%** |
| Sep 1 | (n/a) | **−44.2%** |

Import stayed in ordinary tolerance throughout; export was low by a very
consistent ~42–46% every single day. Backing out what the *uncalibrated*
export magnitude would have been landed within a few percent of SDGE's
own Generation column — meaning the √3 correction, real and necessary for
import, was being wrongly applied to export too, where the raw scaled
value was already accurate.

**The fix**: `withGridDirection()` undoes the calibration factor on the 3
main channels' power (and the derived `totalPower`/`tp`) specifically
when a reading's inferred direction is "exporting" — `channels.js` can't
do this itself, since direction isn't known until after decoration, which
happens downstream of parsing. Existing history needed a matching one-time
rewrite, scoped to just the rows the app's own convention already calls
exports (`tp < 0`):

```bash
# from server/, with the app stopped
node scripts/rescale-export-readings.js 0.5773502691896258
```

Re-checked against the same 4 days after the fix: export error dropped to
−3.0%, +0.8%, and −6.5% (Sep 1 not independently re-verified) — right in
line with import's own tolerance. `totalEnergyIn`/`totalEnergyOut` (the
device's own lifetime cumulative counters, used only for the "Lifetime
net energy" stat tile) are a separate, unvalidated data path and were
deliberately left untouched by this fix.

### Re-validation and import correction (SDGE Green Button + Sunrun, Sep 1 - Oct 15)

Checked SDGE's own 15-minute Green Button exports (delivered + received
channels; two overlapping files, identical where they overlap) and
Sunrun's 15-minute production export against this app's history, interval
by interval:

- **SDGE's intervals reproduce the bill**: 424.5 kWh for Sep 3 - Oct 2 vs
  the bill's 425 — which also confirms the read-date cycle boundaries.
- **The app read that cycle at 402.9 kWh (−5.1%)**, and 20.4 of the 21.6
  kWh gap fell in Sep 3-9, the AC-heavy week.
- **Import error is load-dependent**: over 2,890 import-only intervals,
  `app ≈ 0.883 × true + 137 W` — ~10% high below 1 kW (overnight base
  load), ~10% low at ~5 kW (AC running). Export stays in ordinary
  tolerance and isn't corrected.
- Tested per interval: uncorrected, every period read 2.5-5% low (bill
  cycle −3.5% on a 15-min-netted basis, Sep 1 - Oct 15 −2.5%, Oct 3-15
  −3.6%). With the affine correction, +1.5% / +2.3% / +0.3%, and daily
  error RMS down 16-44%. (An earlier pass over Sep 10 - Oct 15 alone
  showed net within −0.6% and argued against correcting; the AC-heavy
  first week the newer export covers is what tips it.)
- **Solar: −1.1% over Aug 31 - Oct 15** against Sunrun — no change. Daily
  error is episodic (−16% through hot stretches, +10-22% on cloudy days).
  Sunrun's CSV column says "Solar (kW)" but is really kWh per 15-minute
  interval, timestamped at the interval start.

**The import correction** (`calibration.js#getImportCorrection`, Settings
→ Power calibration → Import correction) applies `true = max(0, (reading
− offset) / gain)` to the mains' combined magnitude while importing, in
`index.js#withGridDirection()`, scaling each main channel by the same ratio.
It defaults to the identity (gain 1, offset 0); the fitted values are
**gain 0.883, offset 137 W**. Turning it on needs a matching one-time
rewrite of history:

```bash
# from server/, with the app stopped
node scripts/rescale-import-readings.js 0.883 137
node scripts/backfill-minute-agg.js
```

## History storage

Backed by SQLite (`server/data/sem-meter.db`, via Node's built-in
`node:sqlite` — no extra dependency, no native build step). Two tables:

- **`readings`** — every sample, indexed by timestamp, kept forever. Any
  date range can be queried straight from disk.
- **`daily_stats`** — one row per completed calendar day (avg grid/household
  power, import/export kWh), computed automatically the moment a new day's
  first reading arrives. This is what `byWeekday`/`byWeek` in Analytics read
  from, so those stay cheap no matter how much history piles up — they don't
  rescan raw rows. Today's not-yet-rolled-up data is folded in live.
- **`readings_1m`** — per-minute averages (with the sample count, so coarser
  buckets re-average exactly). Charts whose buckets are a minute or wider
  (`/api/history` over roughly 5 hours or more) read this instead of scanning
  ~43k raw rows per day: a 7-day chart went from ~4-22s and 200MB+ of memory
  to ~0.1s. New minutes are added as they complete; on a fresh install run
  `node scripts/backfill-minute-agg.js` once (newest day first, so a partial
  run can never make a chart silently miss data — history falls back to raw
  rows until the table covers the requested window). It's derived data:
  **re-run that script after anything that rewrites historical raw readings**
  (the `rescale-*.js` scripts above).

Several read paths are also memoized for seconds to minutes (`memo()` in
`store.js`): history (one bucket width, 2-30s) and analytics (10 min). These
scans are synchronous and block the event loop, so identical repeat requests
must not each pay for one.

**Nothing on a request path ever live-scans today's raw readings, or the
current billing cycle's cost estimate.** Both are instead recomputed on a
schedule and cached as plain values (`scheduledJobs.js`, every 15 minutes
and once ~5s after startup): `refreshLiveSnapshot()` for the still-in-progress
day's snapshot (`/api/today-snapshot` and the current day's row in
`/api/daily-snapshots` just read it) and `refreshCurrentCycleCost()` for the
Daily Snapshots page's "Tracking toward your bill" card (`/api/billing/cost-estimate`
reads it — and returns a `computedAt` timestamp so the UI can show "refreshed
X min ago" — whenever the requested range is exactly the current cycle; any
other range, e.g. a past cycle via prev/next, still computes on request,
which is cheap since every day in it is already cached). The only exception
is a cold cache (right after a restart, or the first request of a new
calendar day/cycle before the next tick), which still computes once so the
page never shows nothing.

**Analytics is pre-warmed again, on a 3rd, more solid attempt** — after two
real outages in one afternoon getting here, worth knowing the history before
touching this again:

1. First attempt: a separate worker thread (its own SQLite connection + its
   own V8 heap, so the main event loop would never block on it). Backfired
   on this VM's 450MB memory cap — the worker's heap and page cache stacked
   on top of the main thread's, pinning the whole process at the cap and
   swapping constantly, which made *everything* slow (`/api/health`
   included), not just Analytics.
2. Second attempt: a plain `setInterval()` on the main thread instead (no
   standing memory cost) — but `computeAnalytics()`/`hourlyConsumption()`
   were still scanning raw rows, which turned out far too slow for this
   VM's throttled disk at the database's size by then: a single run was
   measured at 216s and, after fixing a scheduling bug that let two runs
   overlap and compound each other, *273s solo* — during which the whole
   app was unresponsive, since `node:sqlite` queries are fully synchronous
   and a long JS loop over raw rows blocks every other request. Analytics
   warming was pulled entirely after this.
3. Third attempt, what's running now: `computeAnalytics()`/
   `hourlyConsumption()` were rewritten to read from `readings_1m` instead
   of raw rows — the same change that already took `queryHistory()` from
   ~22s to ~0.1s for a 7-day range. Measured directly against production:
   24h went from 1.2s to ~50ms (24x), 7d from ~6.8s to ~135ms (51x) — safe
   to warm on a schedule again (`scheduledJobs.js`, shortly after startup
   and every hour, with a same-job overlap guard as a second line of
   defense). The 90-day daily trend (`dailyConsumption()`, used by weather
   correlation) is deliberately **not** included in the warm-up — it still
   scans raw rows and wasn't part of this rewrite, so it stays lazy
   (computed on first real visit) rather than risk repeating outage #2 for
   a feature nobody's asked to see load instantly.

This wasn't a free win: see `computeAnalytics()`'s doc comment in
`store.js` for what changed. Averages, kWh totals, and the hour-of-day
pattern are numerically identical to the old raw-row computation (verified
directly against production: within 0.0-2.5%). Peak demand, standby load,
and per-circuit std-dev/min/max are *not* — they now reflect per-*minute*
averages rather than the single most extreme 2-second raw reading (observed
~15-30% softer on real data), the same kind of smoothing
`computeSnapshotFromRows()`'s own peak-rejection heuristic already treats as
noise rather than a real load elsewhere in this file. A load that actually
matters (AC compressor, oven) runs for minutes, not seconds, so it's still
captured clearly; what's lost is a genuinely brief (<1 min) spike's exact
instantaneous height.

No setup required; delete `server/data/sem-meter.db*` to reset history.

## Analytics

**Every hour/day/week figure on this page is reckoned in the zip code's
real local timezone, not this VM's own (UTC).** This wasn't always true:
`computeAnalytics()`'s hour-of-day bucketing, `rollupDay()`'s day-of-week
(feeding `byWeekday`/`byWeek`), and the usage-alert baseline
(`hourlyBaselineConsumption()`) all used to compute a bare hour/weekday
*number* via plain JS `Date` methods or SQLite's `'localtime'` modifier —
both of which resolve to the server process's own OS timezone. On a UTC VM
serving a Pacific-time house, that's a 7-8 hour offset baked into the
number itself (not a display issue the browser could correct for, the way
a real timestamp can be re-rendered in the viewer's own zone) — e.g. peak
solar export showing up under "9pm" instead of "2pm". `tz.js` gained
`localHour()`/`localWeekday()`/`localHourStartUtcMs()` (Intl-based, same
technique as `localDateStr()`, with the same per-timezone formatter
caching — these run inside computeAnalytics()'s per-sample loop, so an
uncached `new Intl.DateTimeFormat(...)` per row is the difference between
a ~600ms scheduled warm-up and a ~43s one, measured directly) to fix this
properly, threaded through `addReading()`/`initStore()` and every
Analytics-family function. `daily_stats` (the day-of-week/week rollup
cache) had to be wiped and let rebuild once, since its existing rows had
the wrong dates baked in from before this fix — safe, since it (like
`daily_snapshots`) is pure derived data.

`server/src/store.js#computeAnalytics` aggregates history for the selected
range: per-circuit totals, hour-of-day and day-of-week patterns, weekly grid
import/export, and a handful of notable metrics (peak demand, standby load,
most-cycling circuits, solar self-consumption). It reads from the
`readings_1m` per-minute aggregate when available (see "History storage"
above for why, and exactly which figures are and aren't numerically
identical to a raw-row scan as a result), falling back to raw rows only when
the aggregate doesn't yet cover the range. Because the on-device energy
counters update too coarsely to be useful (see the quirk above), all kWh
figures on this page are **estimated by trapezoidal integration of power
over time**, not read off the hardware counters — accurate as long as
sampling doesn't have long gaps. Day-of-week and week-of-year views are
naturally sparse until the dashboard has been running that long; they fill
in on their own with no changes needed.

## Today's Snapshot & Daily Snapshots

Two views share one computation
([`store.js#computeSnapshotFromRows`](../server/src/store.js)): **produced**,
**pulled from grid**, **exported**, **total consumption**, **warmest**
(+ time), **biggest circuit**, **peak consumption** (+ time, with its
grid/solar split), and **peak production** (+ time — the day's highest
solar output, same lone-sample-glitch rejection as peak consumption).
"Today's snapshot" (top of the Live tab, refreshing every 60s) is today so
far; **Daily Snapshots** (its own tab) is the same fields as a table, one
row per day, most recent first, plus a bottom summary that sums the whole
visible period — handy for checking a given stretch against a bill. The
daily email report (below) is built from this exact same data.

A few things worth knowing about how these are computed:

- **"Today" is timezone-aware**, using the zip code's actual IANA timezone
  ([`server/src/tz.js`](../server/src/tz.js)) rather than the server's own —
  this VM runs UTC, which could otherwise put day boundaries hours off from
  the zip's real midnight. The zip's timezone is resolved once via
  Open-Meteo's `timezone=auto` and cached alongside the location.
- **Producer channels are reclassified to consumers after dark.** A
  producer-tagged circuit is a CT clamp on the solar inverter's own feed,
  and after sunset the inverter still draws a few watts of its own (staying
  powered, syncing status to the solar company's cloud) — through that same
  clamp, indistinguishable from real production by the number alone. Left
  uncorrected this double-counts: the draw already shows up as grid import,
  and counting it *again* as offsetting production inflates the total by 2x
  the draw. Producer channels contribute 0 to "produced" outside
  [sunrise, sunset], widened by a 25-minute grace window on both ends since
  panels measurably keep producing for a while into civil twilight (tuned
  against a real observation: ~230W of genuine production 9 minutes after
  the astronomical sunset moment). Sunrise/sunset come from Open-Meteo's
  `daily=sunrise,sunset` (pure astronomy, no observation lag, so it covers
  historical and current dates the same way), cached per local date. The
  live Channels list on the Live tab reflects the same reclassification —
  a reclassified circuit shows a 🌙 next to its name (hover for why) and
  moves from Production into Consumption for as long as it's night.
- **Peak-finding rejects lone-sample spikes.** This meter occasionally
  reports a main-phase value 20-30x too high for exactly one ~2-second
  sample while every circuit channel stays completely unchanged — a
  corrupted MQTT payload, not a real load (confirmed against raw data: a
  reading jumped to 33kW for one sample with L1/L2 the only thing that
  moved, then reverted). A real load change, like an AC compressor kicking
  in, ramps over multiple consecutive samples and shows up in the circuit
  breakdown too. A candidate peak is only accepted if it isn't wildly
  higher than *both* its immediate neighbors. This only affects which
  instant gets reported as "the peak" — kWh totals are already naturally
  robust to one bad 2-second sample, since trapezoidal integration weights
  by duration.
- **Daily Snapshots' month view is queried one local day at a time**, not
  via one query over the whole range — a full month at this meter's ~2s
  sample cadence is over a million raw rows, easily enough to OOM a small
  VM if held in memory all at once (this happened once during development;
  the fix is what's running now). Peak memory stays bounded to one day's
  rows regardless of how many days are requested.
- **Completed days are cached in a `daily_snapshots` table** (one row per
  day — see [`server/src/store.js`](../server/src/store.js)), so the raw-row
  scan above only ever happens once per day, total, no matter how many
  times that day gets viewed afterward. Normally that cache is already warm
  before anyone looks: right after each local day ends, `index.js` rolls it
  up proactively (same lazy-detection pattern as the sunrise/sunset cache —
  a cheap string compare on every reading that only does real work the
  instant the calendar day changes). If a day's missing from the cache for
  any reason (server downtime across midnight, a gap from before this
  existed), `dailySnapshots()` computes it once, live, and writes it
  through — so it's a one-time cost per day either way, not per view. Only
  today itself is never cached, since it's still changing.
- **Billing periods**: Settings has a "solar billing starts on day" and
  "electric billing starts on day" (1–28) — the solar company and the
  utility often don't bill on the same cycle, or on the calendar month.
  Daily Snapshots can align its calendar and bottom summary to either cycle
  instead of the calendar month, so a period's total can be checked
  directly against the matching real bill.
- **SDGE meter read dates**: SDGE doesn't read on a fixed day — this
  account's cycles closed on Jun 4, Jul 6, Aug 4, Sep 2 and Oct 2, next read
  Nov 3 — so a fixed electric day drifts off the real cycle within a couple
  of bills (the `5` this was set to from the Aug 5 bill put "this cycle" at
  Sep 5 - Oct 4, totalling 490 kWh against the real Sep 3 - Oct 2 bill's
  425). Settings also takes a list of read dates (each bill's billing-period
  end plus its "Next scheduled read date"); when set, they define the
  electric cycle outright as (previous read, this read], and the electric
  day is only an estimate past the last one. Same rule on the server
  (`billing.js#electricCycleRange`, used by the email and the cost cache)
  and in `DailySnapshots.tsx` — keep them in sync, or the gauge silently
  stops hitting its cached current-cycle estimate.

## Bill tracking (tiers & cost estimate)

The Daily Snapshots page (Electric billing tab) and the daily email show
"$ so far / projected" for the current electric billing cycle, using SDGE's
tiered rates for the **net** kWh (pulled from grid minus pushed back) —
`server/src/sdgeRates.js` + `billingCost.js`, one shared implementation for
both surfaces.

- **Tier boundary = 130% of the baseline allowance, over the whole cycle**
  (`10.40 kWh/day x 1.3 x days in cycle` — ~406 kWh for a 30-day cycle),
  measured on the cycle's *cumulative* net usage. It is not prorated to the
  days elapsed so far, so "so far" stays in Tier 1 until cumulative net
  actually crosses the boundary.
- Rates are all-in per-kWh (delivery + generation + wildfire fund + surcharge
  + regulatory fee): 41.4¢ Tier 1 / 52.1¢ Tier 2 (summer). Validated against
  the Aug 5 - Sep 2 bill: 392 + 558 kWh gives $453.28 vs the bill's "NEM
  charges" of $453.35, and the base service charge matches to the cent.
  Re-checked on the Sep 3 - Oct 2 bill (unchanged rates, 312 kWh baseline):
  406 + 19 kWh gives $178.10 vs $178.13.
- This estimates the bill's *NEM charges + base service charge*. It is not
  what you pay that month: the bill also applies banked NEM credits from
  net-export months, the California Climate Credit, and carries the rest to
  the annual true-up (May 5). Winter rates/baseline aren't loaded yet — they
  fall back to summer's (flagged in the UI) until a winter bill is available.
- Days with under 90% of their ~43,200 readings (meter/server offline) are
  marked "partial" in Daily Snapshots; their totals are interpolated across
  the gaps.

## Weather correlation

[`server/src/weather.js`](../server/src/weather.js) resolves the zip code set
in Settings to lat/lon via **Zippopotam.us**, then fetches historical hourly
temperature from **Open-Meteo's archive API** — both free, keyless, no
signup, matching this project's "no new paid dependency" approach. Results
are cached in SQLite (`weather_hourly`, one row per local hour) so an hour
is only ever fetched once.

Saving a new zip **eagerly backfills** temperature from June 1 of the
current year through now in one request, rather than waiting for each date
range to be viewed — a few seconds the first time, instant after that.

Total consumption throughout these charts means **solar produced + grid
imported** (the household's real energy balance, from the main-phase
measurement) — not a sum of whichever breaker circuits happen to be tagged
"consumer", which would undercount any load that isn't on a monitored
circuit.

Analytics has two charts built on this data, from
[`server/src/store.js`](../server/src/store.js) (`hourlyConsumption()`,
`dailyConsumption()`) and surfaced via `/api/weather-correlation` and
`/api/weather-daily`:

- **"Consumption vs outdoor temperature"** — one scatter point per hour in
  the selected range (temperature × total power), plus a **Pearson
  correlation coefficient** and a plain-English read on it (e.g. "Strongly
  tied to temperature — more power the hotter it gets"). Expect a "V" or "U"
  shape as more data accumulates: high power at both temperature extremes
  (heating, AC), lower in mild weather.
- **"Temperature and consumption over time"** — a **Day/Hour toggle**
  switches the x-axis granularity: "Hour" plots the selected Analytics range
  hour by hour; "Day" plots the last 90 days of daily rollups, with
  **hottest/mildest day** callouts and its own correlation read. Either way
  the x-axis is always time — total consumption (solid line, left axis) and
  outdoor temperature (dashed line, right axis) as two differently-colored
  series. This is the one deliberate dual-axis chart in the app: the point
  is to watch two different-unit series move together over time, which a
  same-unit scatter can't show.

Both hover-tooltip to a grid vs. solar vs. total breakdown, not just the
total, so a spike can be traced back to whether it came from the grid or
from solar being consumed on-site.

## Admin login

The dashboard (Live/Slice of time/Analytics) is public; only **Settings**
requires signing in. Single admin account, no user management — built in
[`server/src/auth.js`](../server/src/auth.js):

- **Password storage**: scrypt hash + random salt (`node:crypto`, built in —
  no bcrypt dependency). Plaintext is never persisted.
- **Sessions**: random 32-byte token in an httpOnly, SameSite=Lax cookie,
  stored server-side (SQLite `sessions` table) with a 30-day expiry.
- **Protection is server-side, not just UI**: `PUT /api/channels/:index` — the
  only mutating endpoint — requires a valid session regardless of whether the
  Settings tab is visible. Hiding the tab is a UX nicety, not the security
  boundary.
- **Bootstrap**: on first-ever start, the server creates one admin account
  (`ADMIN_EMAIL` env var, required on first start) with a
  random password, logged **once** at that moment
  (`journalctl -u sem-meter`) since it's never recoverable again after that.
- **Forgot password**: generates a single-use, 1-hour token, emails the reset
  link (`?reset_token=...`) via [`server/src/mail.js`](../server/src/mail.js),
  and always logs it too (`journalctl -u sem-meter`) as a fallback if SMTP
  is ever down or unconfigured. The response to `/api/auth/forgot-password`
  is identical whether or not the email matches, so it can't be used to
  probe who the admin is. A successful reset invalidates every existing
  session, forcing re-login everywhere.
- Loading `/?reset_token=...` auto-opens the "set new password" form and
  immediately scrubs the token from the URL/history.

**Email delivery** goes through Cloudflare's SMTP relay
(`smtp.mx.cloudflare.net:465`), authenticated by API token — the SMTP
username is always the literal string `api_token`, with the token itself
as the password (see `SMTP_HOST`/`SMTP_PORT`/`SMTP_TOKEN`/`MAIL_FROM` in
[`deploy/env.example`](../deploy/env.example)). `MAIL_FROM` must be a sender
address authorized under that Cloudflare account. Without these set, the
app runs fine — reset links just fall back to log-only, as before.

## Alexa Routine trigger ("AC Boost")

Lets the dashboard fire a pre-built Alexa Routine (Settings → "Trigger
'AC Boost'") — e.g. one you set up to adjust an Alexa-exclusive smart
thermostat, which has no API of its own and no way for a third-party
integration to control it directly. The trick: a tiny custom Alexa Skill
exposes one virtual switch, you wire that switch to a real action in a
Routine yourself in the Alexa app, and this app just reports the switch
turning on (and back off, like a momentary button) — Alexa fires the
Routine and does the actual device control with its own native
integration. See [`alexa-skill/README.md`](../alexa-skill/README.md) for the
full one-time setup (a Login with Amazon security profile, the Skill
itself, and a small AWS Lambda — none of it automatable from here, since it
all needs interactive console logins) and
[`server/src/alexaSkill.js`](../server/src/alexaSkill.js) for how the three
separate tokens involved (account linking, the per-user grant, and the
skill's own gateway credential) fit together.

## Installable app, usage alerts & daily email

The site is a installable PWA (manifest + service worker in
[`web/public`](../web/public)) — "Add to Home Screen" / the browser's install
prompt gives it a real icon and `display: standalone`. The service worker
(`sw.js`) is intentionally narrow: it only cache-firsts the build's
content-hashed JS/CSS, and satisfies push notifications. Everything else
(the page shell, `/api/*`, the live WebSocket) always hits the network —
this is a live-data app, so an offline shell showing stale readings would
be actively misleading rather than helpful.

**Cloudflare gotcha**: the service worker is served at `/sw`, not `/sw.js`
— see the route comment in [`server/src/index.js`](../server/src/index.js).
This site is proxied through Cloudflare, whose default edge cache matches
static files by URL extension (`.js` included) and rewrites the response's
`Cache-Control` regardless of what the origin sends, independent of any
Page/Cache Rule. A cached `sw.js` would silently freeze every future
frontend deploy — including future service worker updates — for anyone
who'd already fetched it. `index.html` and `manifest.webmanifest` aren't on
Cloudflare's default cached-extension list and pass through fine as-is
(confirmed via the `cf-cache-status` response header); the extension-less
`/sw` path dodges the same way. If this ever needs revisiting, the real
fix is a Cloudflare Cache Rule bypassing cache for this hostname's `/sw`
path — not available from here without dashboard/API access.

**Usage alerts** push a notification to any subscribed device when
consumption runs well above what's typical for that hour of day:

- [`server/src/alerts.js`](../server/src/alerts.js) runs off the same reading
  stream everything else does (no separate cron/timer), internally
  throttled to check at most once every 5 minutes. It compares a smoothed
  15-minute average against the historical average for that same hour of
  day over the trailing 28 days (via
  [`hourlyBaselineConsumption`](../server/src/store.js) — filtered in SQL, not
  fetched-then-discarded in JS, since the lookback is weeks wide). Alerts
  need at least ~200 historical samples at that hour before trusting the
  baseline, and won't repeat inside a 2-hour cooldown.
- [`server/src/push.js`](../server/src/push.js) wraps the `web-push` package
  for the actual Web Push/VAPID protocol — genuine crypto work, unlike the
  dependencies this project hand-rolled elsewhere (scrypt via
  `node:crypto`, `node:sqlite`), so it's a real dependency rather than
  reimplemented.
- The **bell icon** (sidebar footer, next to the theme toggle) is per-device
  and needs no login — clicking it requests notification permission and
  subscribes that browser. The **threshold and on/off switch** are global
  and admin-only, in Settings.
- Requires `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (see
  [`deploy/env.example`](../deploy/env.example)) — without them the app runs
  fine, the bell just has nothing to subscribe to.

**Daily email report** ([`server/src/dailyEmail.js`](../server/src/dailyEmail.js))
sends a rich HTML recap once each local calendar day finishes — off by
default until an address is set, both configurable in Settings
(enabled toggle + address, admin-only, plus a "send test email now" button
that previews it on demand without waiting for midnight):

- **Trigger**: the exact same lazy day-change detection as the sunrise/sunset
  cache and the `daily_snapshots` rollup — `index.js`'s
  `maybeRollupYesterday()` fires on every reading, is a no-op unless the
  local calendar date just changed, and on the date that just ended, rolls
  up its snapshot *and* sends the email in the same pass (reusing the
  snapshot `persistDailySnapshotIfComplete()` just computed, rather than
  computing it twice).
- **Content**: produced / pulled from grid / total for the day; day-over-day
  % change; biggest circuit and its share of the total; peak household draw
  (with grid/solar split) and peak solar output, each flagged if it's the
  best/highest so far that month; self-consumption % (how much of the day's
  solar was used directly vs. exported); warmest moment; a 7-day trend bar
  chart; and this-month-so-far vs. the same span last month, both as text
  and as a two-bar comparison chart. All of it comes from the same
  `dailySnapshots()`/`computeSnapshotFromRows()` path everything else on the
  Daily Snapshots page uses — no separate, divergent computation to keep in
  sync.
- **Charts are HTML tables, not images or SVG** — a `<td>` with an explicit
  pixel height is the one "bar chart" technique that reliably survives every
  major email client's habit of stripping `<script>`, inconsistent CSS
  support, and (Outlook especially) blocking remote images by default.
- The email is a full standalone HTML document (`<!doctype html>` +
  `<meta charset="utf-8">`), not a bare fragment — found the hard way that
  without an explicit charset, opening the raw HTML directly renders emoji
  and em-dashes as mojibake even though the actual sent email (nodemailer
  sets the MIME charset header correctly) was likely fine either way; the
  explicit tag is the belt-and-suspenders fix.
- Self-consumption is computed from `producedKwh`/`gridExportKwh` on the
  *same* snapshot as the top-line "Produced" figure — both already exclude
  nighttime inverter standby draw via the daylight-switch logic (see
  "Today's Snapshot & Daily Snapshots" above). An earlier draft paired the
  night-aware `producedKwh` against a *different*, unfiltered solar figure
  from `dailyConsumption()` and got exported > produced some days, which
  is physically impossible — the tell that surfaced the mismatch.
- Sent via the same SMTP relay as password-reset email
  ([`server/src/mail.js`](../server/src/mail.js)) — needs the same
  `SMTP_HOST`/`SMTP_PORT`/`SMTP_TOKEN`/`MAIL_FROM` env vars; no-ops quietly
  if they're not set.

## Navigation & design

The app shell is a fixed left sidebar on desktop (`web/src/App.tsx`,
`.sidebar` in `web/src/styles.css`) that collapses to a hamburger-triggered
slide-in drawer under 900px width — a `.mobile-topbar` with a menu button
replaces the sidebar, and a semi-transparent backdrop closes the drawer on
tap-outside. Picking a nav item both switches tabs and closes the drawer
(`selectTab()` calls `setSidebarOpen(false)`), so mobile never leaves it
open after navigating. Global controls (connection status, admin
login/logout, the notification bell, the dark/light toggle) live once in
the sidebar footer rather than duplicated per-breakpoint.

The logo (`web/src/components/Logo.tsx`) is an inline SVG house-roof/omega
pictogram drawn with `stroke="currentColor"`, so it inherits text color and
needs no separate light/dark asset files — unlike the personal "Lange
Cornu" mark on the About page, which still ships as a light/dark SVG pair
swapped via [`useIsDark`](../web/src/useIsDark.ts) (a small hook watching both
`prefers-color-scheme` and the `data-theme` attribute `ThemeToggle` sets).

**About** (`web/src/components/AboutPage.tsx`) is a two-card page: what the
app does (mirrors the top of this README, short-form) and who built it,
with a link to [langecornu.com](https://langecornu.com).

## Production deployment

Production runs at `meter.langecornu.com` on a small dedicated Linux VM (about 1 GB of RAM). Files in
[`deploy/`](../deploy/):

- **`sem-meter.service`** — systemd unit. Runs `node src/index.js` as a
  dedicated `sem-meter` user, auto-restarts on failure, capped at 350MB RAM,
  reads secrets from `/etc/sem-meter/env` (outside the repo checkout).
- **`env.example`** — template for that secrets file
  (`SEMMETER_USER`/`SEMMETER_PASS`/`DEVICE_SN`). Install instructions are in
  the file's own header comment.
- **`nginx-meter.conf`** — reverse-proxy vhost: terminates TLS, proxies `/ws`
  with the Upgrade headers WebSockets need, proxies everything else to the
  same Node process. Mirrors the Cloudflare-origin-cert pattern the
  site's main `langecornu.com` vhost already uses.

**One process serves everything** — `npm run build` in `web/` produces
`web/dist/`, and the server auto-detects and serves it via `express.static`
alongside the API and WebSocket, so nginx only ever proxies to one port
(`8787`).

**Rough deploy flow** (no CI/CD, manual — same style as the other sites on
this account):

```bash
cd web && npm run build           # produces web/dist/
# scp the repo (or just server/, web/dist/, package.json files) to the VM
# on the VM:
cd /opt/sem-meter/server && npm install --omit=dev
sudo install -d -m 750 -o root -g sem-meter /etc/sem-meter
sudo install -m 640 -o root -g sem-meter deploy/env.example /etc/sem-meter/env
sudo $EDITOR /etc/sem-meter/env   # fill in real credentials
sudo cp deploy/sem-meter.service /etc/systemd/system/
sudo systemctl enable --now sem-meter
sudo cp deploy/nginx-meter.conf /etc/nginx/sites-available/meter
sudo ln -s /etc/nginx/sites-available/meter /etc/nginx/sites-enabled/meter
sudo nginx -t && sudo systemctl reload nginx
```

Then point `meter.langecornu.com` DNS at the new VM (Cloudflare, proxied —
same as the other subdomains on this domain) and issue a Cloudflare origin
cert for the nginx config above.
