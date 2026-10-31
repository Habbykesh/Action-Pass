require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/services/analytics/report');

test('percentages always sum to exactly 100.0 (largest remainder)', () => {
  const sets = [[1, 1, 1], [5, 3, 2, 0, 0], [7, 11, 13, 17, 19], [1, 0, 0, 0, 0], [333, 333, 334], [1, 2, 3, 4, 5, 6, 7]];
  for (const s of sets) {
    const p = r.percentages(s);
    const total = Math.round(p.reduce((a, b) => a + b, 0) * 10) / 10;
    assert.equal(total, 100, JSON.stringify(s));
  }
  assert.deepEqual(r.percentages([0, 0, 0]), [0, 0, 0]);
});

test('activity score uses the documented transparent formula', () => {
  const w = { message: 1, reaction: 0.5, voiceMinute: 0.2 };
  assert.equal(r.activityScore({ messages: 10, reactions: 4, voiceSeconds: 600 }, w), 10 + 2 + 2);
});

test('duration formatting', () => {
  assert.equal(r.formatDuration(42), '42s');
  assert.equal(r.formatDuration(3700), '1h 1m');
  assert.equal(r.formatDuration(90000), '1d 1h');
});

test('trend: first vs second half', () => {
  const pts = [10, 10, 20, 20].map((v, i) => ({ date: new Date(Date.UTC(2026, 9, 1 + i)), v }));
  const t = r.computeTrend(pts, (p) => p.v, new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 5)), 'day');
  assert.equal(t.direction, 'up'); assert.equal(Math.round(t.pct), 100);
  assert.equal(r.computeTrend([pts[0]], (p) => p.v, pts[0].date, pts[0].date, 'day'), null);
});

