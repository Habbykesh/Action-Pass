// Orchestrates: flush pending counters → query → compute → render.
// A short TTL cache stops repeated identical commands from re-running
// the same aggregation (and re-drawing the same chart).

const config = require('../../config');
const { chooseIntervals, computeCoverage } = require('./duration');
const queries = require('./queries');
const { buildServerReport, buildMemberReport, fillSeries } = require('./report');
const { renderServerChart, renderMemberChart } = require('./charts');

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function clearCache() {
  cache.clear();
}

function coverageFor(window, state) {
  return computeCoverage(window, state?.trackingStartedAt, state?.pausedFrom, state?.pausedTo, state?.backfilledFrom);
}

async function getServerReport({ guild, window, collector, prisma = collector.prisma }) {
  const key = `server:${guild.id}:${window.amount}${window.unit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  await collector.flush(); // make sure the latest in-memory activity is included
  const state = collector.getGuildState(guild.id);
  const coverage = coverageFor(window, state);
  const intervals = chooseIntervals(window.durationMs);
  const queryStart = coverage.effectiveStart;

  let rows = { stat: [], chart: [], events: [], totals: { activeUsers: 0, messages: 0, reactions: 0, voiceJoins: 0, voiceSeconds: 0 } };
  if (!coverage.noData) {
    const sameGrid = intervals.stat === intervals.chart;
    const [stat, chart, events, totals] = await Promise.all([
      queries.fetchServerSeries(prisma, guild.id, queryStart, window.end, intervals.stat),
      sameGrid ? null : queries.fetchServerSeries(prisma, guild.id, queryStart, window.end, intervals.chart),
      queries.fetchMemberEventSeries(prisma, guild.id, queryStart, window.end, intervals.chart),
      queries.fetchServerTotals(prisma, guild.id, queryStart, window.end),
    ]);
    rows = { stat, chart: chart || stat, events, totals };
  }

  const report = buildServerReport({
    window,
    coverage,
    intervals,
    statSeries: rows.stat,
    chartSeries: rows.chart,
    eventSeries: rows.events,
    totals: rows.totals,
    memberCount: guild.memberCount ?? 0,
  });
  const png = await renderServerChart(report);
  const value = { report, png };
  cacheSet(key, value);
  return value;
}

async function getMemberReport({ guild, member, window, collector, prisma = collector.prisma }) {
  const key = `member:${guild.id}:${member.id}:${window.amount}${window.unit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  await collector.flush();
  const state = collector.getGuildState(guild.id);
  const coverage = coverageFor(window, state);
  const intervals = chooseIntervals(window.durationMs);

  let stat = [];
  let chart = [];
  if (!coverage.noData) {
    stat = await queries.fetchMemberSeries(prisma, guild.id, member.id, coverage.effectiveStart, window.end, intervals.stat);
    chart =
      intervals.stat === intervals.chart
        ? stat
        : await queries.fetchMemberSeries(prisma, guild.id, member.id, coverage.effectiveStart, window.end, intervals.chart);
  }

  const user = {
    id: member.id,
    username: member.user?.username || member.displayName || member.id,
    avatarURL: member.displayAvatarURL?.({ size: 128 }) || null,
  };
  const report = buildMemberReport({ window, coverage, intervals, statSeries: stat, chartSeries: chart, user });
  const png = await renderMemberChart(report);
  const value = { report, png };
  cacheSet(key, value);
  return value;
}

/**
 * Leaderboard: rank in SQL, then keep only members still in the server
 * (over-fetching a little so departures don't leave a short list).
 */
async function getLeaderboard({ guild, window, collector, prisma = collector.prisma, size = config.analytics.leaderboardSize }) {
  const key = `lb:${guild.id}:${window.amount}${window.unit}:${size}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  await collector.flush();
  const state = collector.getGuildState(guild.id);
  const coverage = coverageFor(window, state);
  let rows = [];
  if (!coverage.noData) {
    const raw = await queries.fetchLeaderboard(prisma, guild.id, coverage.effectiveStart, window.end, config.analytics.weights, size * 4 + 10);
    const ids = raw.map((r) => r.userId);
    const missing = ids.filter((id) => !guild.members.cache.has(id));
    if (missing.length) {
      try {
        await guild.members.fetch({ user: missing.slice(0, 100) });
      } catch (err) {
        // Missing permission / timeout: fall back to whoever is cached.
        console.error('[analytics] leaderboard member fetch failed:', err.message);
      }
    }
    for (const r of raw) {
      const m = guild.members.cache.get(r.userId);
      if (!m || m.user.bot) continue;
      rows.push({ ...r, name: m.displayName || m.user.username });
      if (rows.length >= size) break;
    }
  }
  const value = { window, coverage, rows, weights: config.analytics.weights };
  cacheSet(key, value);
  return value;
}

module.exports = { getServerReport, getMemberReport, getLeaderboard, clearCache, coverageFor };
