// Flexible reporting-period parsing and window maths.
//
// Everything here is pure (no Discord, no DB) and works in UTC only.
// "Previous N months/years" are CALENDAR subtractions with month-end
// clamping (Mar 31 − 1 month = Feb 28/29; Feb 29 − 1 year = Feb 28),
// while hours/days/weeks are exact fixed-length durations.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const UNIT_ALIASES = {
  hour: 'hour', hours: 'hour',
  day: 'day', days: 'day',
  week: 'week', weeks: 'week',
  month: 'month', months: 'month',
  year: 'year', years: 'year',
};

const SUPPORTED_UNITS_TEXT = 'hours, days, weeks, months, years';

function daysInMonthUtc(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** UTC calendar subtraction with end-of-month clamping. */
function subtractCalendarMonths(date, months) {
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() - months;
  const year = Math.floor(total / 12);
  const monthIndex = total - year * 12;
  const day = Math.min(date.getUTCDate(), daysInMonthUtc(year, monthIndex));
  const d = new Date(
    Date.UTC(
      year,
      monthIndex,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
  // Date.UTC treats years 0-99 as 1900-1999; irrelevant at our scale
  // (max period is a few years) but guard against invalid dates.
  return Number.isNaN(d.getTime()) ? null : d;
}

function subtractPeriod(now, amount, unit) {
  switch (unit) {
    case 'hour':
      return new Date(now.getTime() - amount * HOUR_MS);
    case 'day':
      return new Date(now.getTime() - amount * DAY_MS);
    case 'week':
      return new Date(now.getTime() - amount * 7 * DAY_MS);
    case 'month':
      return subtractCalendarMonths(now, amount);
    case 'year':
      return subtractCalendarMonths(now, amount * 12);
    default:
      return null;
  }
}

/**
 * Parses "6hours", "1day", "2 weeks" style text into {amount, unit}.
 * Returns {error} with a user-presentable message on any problem.
 */
function parseDuration(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(String(text ?? ''));
  if (!m) {
    return { error: `I couldn't read that duration. Use a number plus a unit, e.g. \`6hours\`, \`14days\`, \`2weeks\`, \`4months\`, \`1year\`.` };
  }
  const [, numText, unitText] = m;
  const unit = UNIT_ALIASES[unitText.toLowerCase()];
  if (!unit) {
    return { error: `Unsupported unit \`${unitText}\`. Supported units: ${SUPPORTED_UNITS_TEXT}.` };
  }
  if (numText.includes('.')) {
    return { error: `Please use a whole number (got \`${numText}\`). For example \`36hours\` instead of \`1.5days\`.` };
  }
  const amount = Number(numText);
  if (amount <= 0) {
    return { error: `The duration must be at least 1 (got \`${numText}\`).` };
  }
  if (numText.length > 6) {
    return { error: 'That duration is far too large.' };
  }
  return { amount, unit };
}

function pluralizeUnit(amount, unit) {
  return amount === 1 ? unit : `${unit}s`;
}

/**
 * Builds the reporting window ending at `now`. `maxDays` is the
 * configurable cap that protects the database from huge scans.
 */
function computeWindow(amount, unit, now = new Date(), maxDays = 730) {
  const start = subtractPeriod(now, amount, unit);
  if (!start) return { error: 'That duration is out of range.' };
  const days = (now.getTime() - start.getTime()) / DAY_MS;
  if (days > maxDays) {
    return {
      error: `That period (~${Math.round(days)} days) exceeds the maximum of **${maxDays} days**. Try a shorter period.`,
    };
  }
  return {
    start,
    end: now,
    amount,
    unit,
    label: `Last ${amount} ${pluralizeUnit(amount, unit)}`,
    durationMs: now.getTime() - start.getTime(),
  };
}

/**
 * Aggregation intervals.
 *  - stat interval: used for "peak / average active users" and daily
 *    trends — hourly for windows up to 48h, daily otherwise.
 *  - chart interval: hourly ≤ 48h, daily ≤ 90 days, weekly beyond, so a
 *    chart never has more than ~105 points.
 */
function chooseIntervals(durationMs) {
  const days = durationMs / DAY_MS;
  if (days <= 2) return { stat: 'hour', chart: 'hour' };
  if (days <= 90) return { stat: 'day', chart: 'day' };
  return { stat: 'day', chart: 'week' };
}

function floorToInterval(date, interval) {
  const t = date.getTime();
  if (interval === 'hour') return new Date(Math.floor(t / HOUR_MS) * HOUR_MS);
  const day = Math.floor(t / DAY_MS) * DAY_MS;
  if (interval === 'day') return new Date(day);
  if (interval === 'week') {
    // ISO week: Monday 00:00 UTC (matches Postgres date_trunc('week')).
    const dow = (new Date(day).getUTCDay() + 6) % 7; // Mon=0
    return new Date(day - dow * DAY_MS);
  }
  throw new Error(`Unknown interval ${interval}`);
}

function nextBucket(date, interval) {
  if (interval === 'hour') return new Date(date.getTime() + HOUR_MS);
  if (interval === 'day') return new Date(date.getTime() + DAY_MS);
  return new Date(date.getTime() + 7 * DAY_MS);
}

/** Every bucket start covering [start, end], in order. */
function buildBuckets(start, end, interval) {
  const out = [];
  let cur = floorToInterval(start, interval);
  while (cur.getTime() <= end.getTime()) {
    out.push(cur);
    cur = nextBucket(cur, interval);
  }
  return out;
}

/**
 * How much of the requested window the analytics can actually cover,
 * given when tracking began (and any recorded pause).
 */
function computeCoverage(window, trackingStartedAt, pausedFrom = null, pausedTo = null, backfilledFrom = null) {
  const started = trackingStartedAt ? new Date(trackingStartedAt) : null;
  const backfill = backfilledFrom ? new Date(backfilledFrom) : null;
  // Backfilled history extends coverage backwards (messages / joins /
  // approximate reactions only; voice and leaves still start at `started`).
  const covered = started && backfill && backfill < started ? backfill : started;
  const effectiveStart = covered && covered > window.start ? covered : window.start;
  const noData = !started || started >= window.end;
  const partial = Boolean(covered && covered > window.start);
  const coveredMs = noData ? 0 : window.end.getTime() - effectiveStart.getTime();

  let pauseOverlaps = false;
  if (pausedFrom) {
    const pf = new Date(pausedFrom).getTime();
    const pt = pausedTo ? new Date(pausedTo).getTime() : window.end.getTime();
    pauseOverlaps = pf < window.end.getTime() && pt > window.start.getTime();
  }

  return {
    started,
    backfilledFrom: backfill && started && backfill < started ? backfill : null,
    effectiveStart,
    noData,
    partial,
    coveredMs,
    coveredFraction: window.durationMs > 0 ? Math.min(1, coveredMs / window.durationMs) : 0,
    pauseOverlaps,
    pausedFrom: pausedFrom ? new Date(pausedFrom) : null,
    pausedTo: pausedTo ? new Date(pausedTo) : null,
  };
}

module.exports = {
  HOUR_MS,
  DAY_MS,
  SUPPORTED_UNITS_TEXT,
  parseDuration,
  computeWindow,
  subtractPeriod,
  chooseIntervals,
  floorToInterval,
  nextBucket,
  buildBuckets,
  computeCoverage,
  pluralizeUnit,
};
