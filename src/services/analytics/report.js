// Turns raw query rows into report numbers. Pure functions, no I/O.
//
// DEFINITIONS (shown to users via `!analytics help`):
//  • Active user    — unique non-bot member with ≥1 tracked activity
//                     (message, reaction added, or voice session) in the window.
//  • Engagements    — messages + reactions added + voice sessions started.
//                     Each event is counted exactly once. Member joins/leaves
//                     are NOT engagements (they're membership changes).
//  • Activity share — each of messages / reactions / voice sessions / joins /
//                     leaves as a % of the sum of those five event counts.
//                     Percentages are rounded with the largest-remainder
//                     method so they always add up to exactly 100.0%.
//  • Activity score — messages × 1 + reactions × 0.5 + voice minutes × 0.2.

const { DAY_MS, HOUR_MS, buildBuckets, floorToInterval } = require('./duration');

function intervalMs(interval) {
  return interval === 'hour' ? HOUR_MS : interval === 'day' ? DAY_MS : 7 * DAY_MS;
}

function sum(rows, field) {
  return rows.reduce((a, r) => a + (r[field] || 0), 0);
}

/** Percent shares at 1 decimal that always total exactly 100.0. */
function percentages(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 1000); // tenths of a percent
  const floors = raw.map(Math.floor);
  let remainder = 1000 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) floors[order[k].i] += 1;
  return floors.map((t) => t / 10);
}

function activityScore(row, weights) {
  return row.messages * weights.message + row.reactions * weights.reaction + (row.voiceSeconds / 60) * weights.voiceMinute;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Zero-filled series over every bucket in [start, end]. */
function fillSeries(start, end, interval, rows, fields) {
  const byTs = new Map(rows.map((r) => [new Date(r.ts).getTime(), r]));
  return buildBuckets(start, end, interval).map((date) => {
    const found = byTs.get(date.getTime());
    const point = { date };
    for (const f of fields) point[f] = found ? found[f] || 0 : 0;
    return point;
  });
}

/**
 * First-half vs second-half comparison of a value over the covered
 * period. Returns null when there isn't enough data to say anything.
 */
function computeTrend(points, valueFn, start, end, interval) {
  if (points.length < 2) return null;
  const mid = (start.getTime() + end.getTime()) / 2;
  const half = intervalMs(interval) / 2;
  let first = 0;
  let second = 0;
  for (const p of points) {
    const v = valueFn(p);
    if (p.date.getTime() + half < mid) first += v;
    else second += v;
  }
  if (first === 0 && second === 0) return { first, second, pct: 0, direction: 'flat' };
  if (first === 0) return { first, second, pct: null, direction: 'up' };
  const pct = ((second - first) / first) * 100;
  const direction = Math.abs(pct) < 5 ? 'flat' : pct > 0 ? 'up' : 'down';
  return { first, second, pct, direction };
}

function trendLabel(trend) {
  if (!trend) return 'Not enough data yet';
  if (trend.direction === 'flat') return '➡️ Stable';
  if (trend.pct === null) return '📈 New activity in the second half';
  const arrow = trend.direction === 'up' ? '📈' : '📉';
  return `${arrow} ${trend.pct > 0 ? '+' : ''}${trend.pct.toFixed(0)}% vs. first half`;
}

function buildServerReport({ window, coverage, intervals, statSeries, chartSeries, eventSeries, totals, memberCount }) {
  const covStart = coverage.effectiveStart;
  const chartPoints = fillSeries(covStart, window.end, intervals.chart, chartSeries, ['active', 'messages', 'reactions', 'voiceJoins', 'voiceSeconds']);
  const eventPoints = fillSeries(covStart, window.end, intervals.chart, eventSeries, ['joins', 'leaves']);
  const statPoints = fillSeries(covStart, window.end, intervals.stat, statSeries, ['active', 'messages', 'reactions', 'voiceJoins']);

  // Chart points merge activity + member events (same bucket grid).
  const chart = chartPoints.map((p, i) => ({
    ...p,
    engagements: p.messages + p.reactions + p.voiceJoins,
    joins: eventPoints[i]?.joins || 0,
    leaves: eventPoints[i]?.leaves || 0,
  }));

  const memberJoins = sum(eventPoints, 'joins');
  const memberLeaves = sum(eventPoints, 'leaves');
  const engagements = totals.messages + totals.reactions + totals.voiceJoins;

  let peak = null;
  for (const p of statPoints) {
    if (p.active > 0 && (!peak || p.active > peak.active)) peak = { active: p.active, date: p.date };
  }
  const averageActive = statPoints.length ? sum(statPoints, 'active') / statPoints.length : 0;

  const shareValues = [totals.messages, totals.reactions, totals.voiceJoins, memberJoins, memberLeaves];
  const shares = percentages(shareValues);

  // Busiest bucket by engagements (stat grid).
  let busiest = null;
  for (const p of statPoints) {
    const e = p.messages + p.reactions + p.voiceJoins;
    if (e > 0 && (!busiest || e > busiest.engagements)) busiest = { engagements: e, date: p.date };
  }
  const trend = computeTrend(statPoints, (p) => p.messages + p.reactions + p.voiceJoins, covStart, window.end, intervals.stat);

  return {
    kind: 'server',
    window,
    coverage,
    intervals,
    memberCount,
    activeUsers: totals.activeUsers,
    activityRate: memberCount > 0 ? (totals.activeUsers / memberCount) * 100 : null,
    totals: {
      messages: totals.messages,
      reactions: totals.reactions,
      voiceSessions: totals.voiceJoins,
      voiceSeconds: totals.voiceSeconds,
      memberJoins,
      memberLeaves,
    },
    engagements,
    avgMessagesPerActive: totals.activeUsers ? totals.messages / totals.activeUsers : 0,
    avgReactionsPerActive: totals.activeUsers ? totals.reactions / totals.activeUsers : 0,
    peak,
    averageActive,
    busiest,
    trend,
    breakdown: {
      labels: ['Messages', 'Reactions', 'Voice sessions', 'Member joins', 'Member leaves'],
      counts: shareValues,
      percents: shares,
    },
    chart,
    isEmpty: engagements === 0 && memberJoins === 0 && memberLeaves === 0,
  };
}

function buildMemberReport({ window, coverage, intervals, statSeries, chartSeries, user }) {
  const covStart = coverage.effectiveStart;
  const fields = ['messages', 'reactions', 'voiceJoins', 'voiceSeconds'];
  const statPoints = fillSeries(covStart, window.end, intervals.stat, statSeries, fields);
  const chartPoints = fillSeries(covStart, window.end, intervals.chart, chartSeries, fields);
  const chart = chartPoints.map((p) => ({ ...p, engagements: p.messages + p.reactions + p.voiceJoins }));

  const messages = sum(statPoints, 'messages');
  const reactions = sum(statPoints, 'reactions');
  const voiceSessions = sum(statPoints, 'voiceJoins');
  const voiceSeconds = sum(statPoints, 'voiceSeconds');
  const engagements = messages + reactions + voiceSessions;

  // Average per day over the covered period, with a 1-day floor so a
  // 6-hour window isn't extrapolated into a misleading daily rate.
  const coveredDays = Math.max(1, coverage.coveredMs / DAY_MS);

  // Most active UTC day — computed from a daily grid regardless of the
  // stat interval (hourly points roll up into their day).
  const perDay = new Map();
  for (const p of statPoints) {
    const day = floorToInterval(p.date, 'day').getTime();
    perDay.set(day, (perDay.get(day) || 0) + p.messages + p.reactions + p.voiceJoins);
  }
  let mostActiveDay = null;
  for (const [day, e] of [...perDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (e > 0 && (!mostActiveDay || e > mostActiveDay.engagements)) mostActiveDay = { date: new Date(day), engagements: e };
  }

  const trend = computeTrend(statPoints, (p) => p.messages + p.reactions + p.voiceJoins, covStart, window.end, intervals.stat);

  return {
    kind: 'member',
    window,
    coverage,
    intervals,
    user,
    messages,
    reactions,
    voiceSessions,
    voiceSeconds,
    engagements,
    avgDailyEngagements: engagements / coveredDays,
    mostActiveDay,
    trend,
    chart,
    isEmpty: engagements === 0 && voiceSeconds === 0,
  };
}

module.exports = {
  percentages,
  activityScore,
  formatDuration,
  fillSeries,
  computeTrend,
  trendLabel,
  buildServerReport,
  buildMemberReport,
  intervalMs,
};
