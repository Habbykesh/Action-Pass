require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/services/analytics/duration');

const NOW = new Date('2026-10-30T12:34:56.789Z');

test('valid durations parse (singular, plural, spaced, any case)', () => {
  const cases = {
    '6hours': [6, 'hour'], '1hour': [1, 'hour'], '1day': [1, 'day'], '5days': [5, 'day'], '365days': [365, 'day'],
    '2weeks': [2, 'week'], '1week': [1, 'week'], '4months': [4, 'month'], '1month': [1, 'month'],
    '1year': [1, 'year'], '2years': [2, 'year'], '14 DAYS': [14, 'day'],
  };
  for (const [txt, [amount, unit]] of Object.entries(cases)) assert.deepEqual(d.parseDuration(txt), { amount, unit }, txt);
});

test('invalid durations give clear errors', () => {
  for (const txt of ['0days', '-5days', '1.5days', '5minutes', '3fortnights', 'days', '9999999days', '']) {
    const r = d.parseDuration(txt);
    assert.ok(r && r.error, `${txt} should error, got ${JSON.stringify(r)}`);
  }
});

test('fixed-length units are exact', () => {
  assert.equal(d.computeWindow(6, 'hour', NOW).start.toISOString(), '2026-10-30T06:34:56.789Z');
  assert.equal(d.computeWindow(14, 'day', NOW).start.toISOString(), '2026-10-16T12:34:56.789Z');
  assert.equal(d.computeWindow(2, 'week', NOW).start.toISOString(), '2026-10-16T12:34:56.789Z');
  assert.equal(d.computeWindow(1, 'day', NOW).label, 'Last 1 day');
  assert.equal(d.computeWindow(5, 'day', NOW).label, 'Last 5 days');
});

test('calendar months/years: month-end clamping and leap years', () => {
  const sub = (iso, n, u) => d.subtractPeriod(new Date(iso), n, u).toISOString();
  assert.equal(sub('2026-03-31T10:00:00Z', 1, 'month'), '2026-02-28T10:00:00.000Z');
  assert.equal(sub('2028-03-31T10:00:00Z', 1, 'month'), '2028-02-29T10:00:00.000Z'); // leap
  assert.equal(sub('2026-05-31T10:00:00Z', 1, 'month'), '2026-04-30T10:00:00.000Z');
  assert.equal(sub('2026-01-15T10:00:00Z', 2, 'month'), '2025-11-15T10:00:00.000Z'); // year rollover
  assert.equal(sub('2026-10-30T12:00:00Z', 4, 'month'), '2026-06-30T12:00:00.000Z');
  assert.equal(sub('2028-02-29T10:00:00Z', 1, 'year'), '2027-02-28T10:00:00.000Z');
  assert.equal(sub('2026-10-30T12:00:00Z', 1, 'year'), '2025-10-30T12:00:00.000Z');
  assert.equal(sub('2026-03-01T00:00:00Z', 12, 'month'), '2025-03-01T00:00:00.000Z');
  // 1 calendar year spanning a leap day is 366 days, not 365
  const w = d.computeWindow(1, 'year', new Date('2028-10-30T00:00:00Z'));
  assert.equal(Math.round(w.durationMs / d.DAY_MS), 365 + 1);
});

test('maximum period is enforced and configurable', () => {
  assert.ok(d.computeWindow(3, 'year', NOW, 730).error);
  assert.ok(!d.computeWindow(730, 'day', NOW, 730).error);
  assert.ok(d.computeWindow(731, 'day', NOW, 730).error);
  assert.ok(!d.computeWindow(2, 'year', NOW, 800).error);
  assert.ok(d.computeWindow(40, 'day', NOW, 30).error);
});

test('aggregation interval selection keeps charts readable', () => {
  const c = (n, u) => d.chooseIntervals(d.computeWindow(n, u, NOW, 9999).durationMs);
  assert.deepEqual(c(6, 'hour'), { stat: 'hour', chart: 'hour' });
  assert.deepEqual(c(48, 'hour'), { stat: 'hour', chart: 'hour' });
  assert.deepEqual(c(5, 'day'), { stat: 'day', chart: 'day' });
  assert.deepEqual(c(90, 'day'), { stat: 'day', chart: 'day' });
  assert.deepEqual(c(180, 'day'), { stat: 'day', chart: 'week' });
  assert.deepEqual(c(1, 'year'), { stat: 'day', chart: 'week' });
});

test('bucket grid: hourly/daily/ISO-week alignment', () => {
  const s = new Date('2026-10-28T13:20:00Z'); // Wednesday
  assert.equal(d.floorToInterval(s, 'hour').toISOString(), '2026-10-28T13:00:00.000Z');
  assert.equal(d.floorToInterval(s, 'day').toISOString(), '2026-10-28T00:00:00.000Z');
  assert.equal(d.floorToInterval(s, 'week').toISOString(), '2026-10-26T00:00:00.000Z'); // Monday
  assert.equal(d.floorToInterval(new Date('2026-11-01T05:00:00Z'), 'week').toISOString(), '2026-10-26T00:00:00.000Z'); // Sunday
  assert.equal(d.buildBuckets(new Date('2026-10-30T06:34:56Z'), NOW, 'hour').length, 7);
  assert.equal(d.buildBuckets(d.computeWindow(30, 'day', NOW).start, NOW, 'day').length, 31);
});

test('coverage flags partial history, no data, and pauses', () => {
  const w = d.computeWindow(30, 'day', NOW);
  const full = d.computeCoverage(w, new Date('2026-01-01T00:00:00Z'));
  assert.equal(full.partial, false); assert.equal(full.coveredFraction, 1);
  const partial = d.computeCoverage(w, new Date('2026-10-23T12:34:56.789Z'));
  assert.equal(partial.partial, true);
  assert.ok(Math.abs(partial.coveredFraction - 7 / 30) < 0.001);
  assert.equal(d.computeCoverage(w, null).noData, true);
  assert.equal(d.computeCoverage(w, new Date('2026-10-31T00:00:00Z')).noData, true);
  const paused = d.computeCoverage(w, new Date('2026-01-01T00:00:00Z'), new Date('2026-10-20T00:00:00Z'), new Date('2026-10-21T00:00:00Z'));
  assert.equal(paused.pauseOverlaps, true);
  const oldPause = d.computeCoverage(w, new Date('2026-01-01T00:00:00Z'), new Date('2026-02-20T00:00:00Z'), new Date('2026-02-21T00:00:00Z'));
  assert.equal(oldPause.pauseOverlaps, false);
});
