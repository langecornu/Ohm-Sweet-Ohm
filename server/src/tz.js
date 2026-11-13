// IANA-timezone-aware date helpers, using only Intl (no dependency — the
// same "no new dependency unless it's real protocol work" approach as the
// rest of this project). This VM runs in UTC; the zip code configured in
// Settings can be hours away from that, so "today" has to be reckoned in
// the zip's timezone, not the server's own.

// Constructing an Intl.DateTimeFormat does real locale/timezone-database
// work — cheap once, not cheap to redo on every call. wallClockToUtcMs()
// used to rebuild one from scratch every time; that was fine when every
// caller here ran at most a few times per request, but localHourStartUtcMs()
// below calls it once per *sample* inside hourlyConsumption()'s aggregation
// loop (thousands of calls for one request) — measured directly against
// production, that alone took a scheduled analytics warm-up from ~320ms to
// ~43s. One cached formatter per timezone fixes it for every caller here.
const wallClockFormatters = new Map();
function wallClockFormatter(timezone) {
  let f = wallClockFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallClockFormatters.set(timezone, f);
  }
  return f;
}

/** UTC epoch ms for local wall-clock components (mo is 1-12) as they'd read
 * in `timezone` — found by guessing, checking what that guess *shows* as in
 * `timezone`, and correcting by the difference. Standard technique for
 * timezone conversion with nothing but Intl. */
function wallClockToUtcMs(y, mo, d, h, mi, timezone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const parts = Object.fromEntries(wallClockFormatter(timezone).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const shownAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // Intl uses "24" for midnight with hour12:false
    Number(parts.minute),
    Number(parts.second)
  );
  return guess - (shownAsUtc - guess);
}

/** UTC epoch ms for 00:00 of the calendar day containing `ts`, as that day
 * is reckoned in `timezone` — i.e. "today" for whoever lives there. */
export function dayStartUtcMs(ts, timezone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return wallClockToUtcMs(Number(parts.year), Number(parts.month), Number(parts.day), 0, 0, timezone);
}

/** UTC epoch ms for 00:00 of an explicit "YYYY-MM-DD" date, as reckoned in
 * `timezone` — the inverse of localDateStr(). */
export function localDateToUtcMs(dateStr, timezone) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return wallClockToUtcMs(y, mo, d, 0, 0, timezone);
}

/** UTC epoch ms for an Open-Meteo-style "YYYY-MM-DDTHH:mm" string that's
 * labeled in `timezone` (no offset in the string itself — `new Date(str)`
 * would silently parse it in the *server's* local timezone instead, which
 * is wrong whenever the zip's zone differs from this VM's). */
export function localIsoToUtcMs(isoLocalNoOffset, timezone) {
  const [datePart, timePart] = isoLocalNoOffset.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  return wallClockToUtcMs(y, mo, d, h, mi, timezone);
}

const dateStrFormatters = new Map();
function dateStrFormatter(timezone) {
  let f = dateStrFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateStrFormatters.set(timezone, f);
  }
  return f;
}

/** "YYYY-MM-DD" for `ts` as reckoned in `timezone` — en-CA locale formats
 * dates in that order directly, no manual assembly needed. Called per-row
 * inside computeAnalytics()'s aggregation loop (store.js), so — like every
 * other formatter in this file — its Intl.DateTimeFormat is cached per
 * timezone rather than rebuilt on every call. */
export function localDateStr(ts, timezone) {
  return dateStrFormatter(timezone).format(new Date(ts));
}

// Formatters are expensive to construct (locale/timezone-database lookup)
// but cheap to reuse — cached per timezone rather than rebuilt on every
// call, since localHour()/localWeekday() below run inside per-sample
// aggregation loops (computeAnalytics() et al.) that can call them tens of
// thousands of times for one request.
const hourFormatters = new Map();
function hourFormatter(timezone) {
  let f = hourFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hour12: false });
    hourFormatters.set(timezone, f);
  }
  return f;
}

/** Local hour-of-day (0-23) for `ts` as reckoned in `timezone`. */
export function localHour(ts, timezone) {
  // hour12:false formats midnight as "24" (same quirk wallClockToUtcMs()
  // above already works around), not "00" — %24 folds it back to 0.
  return Number(hourFormatter(timezone).format(new Date(ts))) % 24;
}

const hourBucketFormatters = new Map();
function hourBucketFormatter(timezone) {
  let f = hourBucketFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    hourBucketFormatters.set(timezone, f);
  }
  return f;
}

/** UTC epoch ms for the start of the local hour containing `ts`, as reckoned in `timezone` — the bucket key for "average by hour" charts. */
export function localHourStartUtcMs(ts, timezone) {
  const parts = Object.fromEntries(hourBucketFormatter(timezone).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return wallClockToUtcMs(Number(parts.year), Number(parts.month), Number(parts.day), Number(parts.hour) % 24, 0, timezone);
}

const weekdayFormatters = new Map();
function weekdayFormatter(timezone) {
  let f = weekdayFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" });
    weekdayFormatters.set(timezone, f);
  }
  return f;
}
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local day-of-week for `ts` as reckoned in `timezone` — 0=Sunday..6=Saturday, same convention as JS Date#getDay(). */
export function localWeekday(ts, timezone) {
  return WEEKDAY_INDEX[weekdayFormatter(timezone).format(new Date(ts))];
}

// Open-Meteo's `sunrise`/`sunset` are the astronomical moment (sun's disk
// touches the horizon) — the original assumption here was that panels keep
// producing a little past that in either direction (ordinary civil
// twilight), so the window was *widened* outward by a symmetric ~25
// minutes. That assumption doesn't hold for this installation: measured
// directly from 5 days of actual production ramp-up/ramp-down transitions
// (see README's "Power calibration" section), the array doesn't start
// producing anything real until ~101-114 minutes *after* sunrise, and
// stops ~53-62 minutes *before* sunset — the opposite direction from
// "twilight," and much larger. That kind of morning-heavy asymmetry (110
// min vs. 58 min) is the signature of an obstruction specific to this
// property blocking direct light low on the eastern horizon — a hill,
// trees, a neighboring roofline — not a generic astronomical effect, so
// these are property-specific offsets, not a twilight constant someone
// else's install should reuse as-is. The window is *narrowed* inward by
// these amounts instead of widened, with a small safety margin above the
// largest observed offset in each direction (so a still-phantom morning
// reading doesn't get counted as real production, at the minor cost of
// clipping a few minutes of genuine low-light production at either edge).
const MORNING_OFFSET_MS = 115 * 60 * 1000;
const EVENING_OFFSET_MS = 65 * 60 * 1000;

/** Whether `ts` falls within the *actual* production window for this
 * installation — `sunWindow`'s astronomical {sunriseTs, sunsetTs}, narrowed
 * inward by MORNING_OFFSET_MS / EVENING_OFFSET_MS to match when the array
 * really starts/stops producing (see header comment above). `sunWindow` may
 * be null (unknown, e.g. no zip configured) — callers should decide their
 * own fallback in that case. */
export function isWithinDaylight(ts, sunWindow) {
  if (!sunWindow) return null;
  return ts >= sunWindow.sunriseTs + MORNING_OFFSET_MS && ts < sunWindow.sunsetTs - EVENING_OFFSET_MS;
}
