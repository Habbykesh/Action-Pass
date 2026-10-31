const { shim, resetDb, closeDb, getPool, silentLogger, hasDb } = require('./helpers/setup');
const { fakeUser, fakeMember, fakeGuild, fakeInteraction } = require('./helpers/fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');

const skip = hasDb ? false : 'set TEST_DATABASE_URL to run database tests';
const { AnalyticsCollector } = require('../src/services/analytics/collector');
const { runBackfill, snowflakeFromMs } = require('../src/services/analytics/backfill');
const analytics = require('../src/commands/analytics');
const { collector: sharedCollector } = require('../src/services/analytics/collector');
const reportService = require('../src/services/analytics/reportService');
const { computeWindow, DAY_MS, HOUR_MS } = require('../src/services/analytics/duration');

const G = '600000000000000001';
const A = '700000000000000001', B = '700000000000000002', C = '700000000000000003', BOTU = '700000000000000009', ADMIN = '700000000000000100';
const NOW = Date.now();
const ago = (ms) => NOW - ms;

let seq = 0;
function fmsg(userId, ts, { bot = false, reactions = [] } = {}) {
  const id = snowflakeFromMs(ts) .replace(/.$/, String(seq++ % 10)); // unique-ish, still ordered by time
  const cache = new Map(reactions.map((r, i) => [`e${i}`, { count: r.length, users: { fetch: async () => new Map(r.map((u) => [u.id, u])) } }]));
  return { id, createdTimestamp: ts, author: { id: userId, bot }, webhookId: null, system: false, reactions: { cache } };
}
function fchannel(name, msgs, { perms = true, fail = false } = {}) {
  return {
    name,
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => perms }),
    messages: {
      async fetch({ limit, before }) {
        if (fail) throw new Error('Missing Access');
        const lim = BigInt(before);
        const out = msgs.filter((m) => BigInt(m.id) < lim).sort((a, b) => b.createdTimestamp - a.createdTimestamp).slice(0, limit);
        return new Map(out.map((m) => [m.id, m]));
      },
    },
  };
}

async function build({ channels, tracked = 1 * DAY_MS }) {
  await getPool().query('TRUNCATE "ActivityHourly","ActivityMemberEvent","ActivityVoiceSession","GuildAnalyticsConfig" RESTART IDENTITY');
  reportService.clearCache();
  const members = [
    { ...fakeMember(A, 'alice'), joinedTimestamp: ago(20 * DAY_MS) },
    { ...fakeMember(B, 'bob'), joinedTimestamp: ago(40 * DAY_MS) },
    { ...fakeMember(C, 'carol'), joinedTimestamp: ago(0.5 * DAY_MS) }, // joined AFTER tracking began → live path, not backfill
    { ...fakeMember(ADMIN, 'adm', { admin: true }), joinedTimestamp: ago(300 * DAY_MS) },
    { ...fakeMember(BOTU, 'bot', { bot: true }), joinedTimestamp: ago(10 * DAY_MS) },
  ];
  const guild = fakeGuild(G, 'Backfill Guild', members);
  guild.members.me = { id: 'bot' };
  for (const ch of channels) guild.channels.cache.set(ch.name, ch);
  const c = new AnalyticsCollector({ prisma: shim, logger: silentLogger, flushIntervalMs: 1e9 });
  c.client = { guilds: { cache: new Map([[G, guild]]) } };
  await c.enableGuild(G);
  await getPool().query(`UPDATE "GuildAnalyticsConfig" SET "trackingStartedAt" = $2::timestamp WHERE "guildId" = $1`, [G, new Date(ago(tracked)).toISOString()]);
  await c.loadGuildStates();
  return { guild, c };
}

const alice = fakeUser(A, 'alice'), bob = fakeUser(B, 'bob'), botUser = fakeUser(BOTU, 'bot', true);

test.before(async () => { if (hasDb) await resetDb(); });
test.after(async () => { await closeDb(); });

test('recovers messages, joins and approximate reactions only from BEFORE live tracking', { skip }, async () => {
  const general = fchannel('general', [
    fmsg(A, ago(5 * DAY_MS)), fmsg(A, ago(5 * DAY_MS) + 1000), fmsg(B, ago(10 * DAY_MS), { reactions: [[alice, bob, botUser]] }),
    fmsg(A, ago(29 * DAY_MS)),
    fmsg(B, ago(45 * DAY_MS)),                      // older than 30 days → out of range
    fmsg(A, ago(2 * HOUR_MS)),                      // after tracking started → live path owns it
    fmsg(BOTU, ago(6 * DAY_MS), { bot: true }),     // bot → excluded
  ]);
  const random = fchannel('random', [fmsg(B, ago(3 * DAY_MS)), fmsg(B, ago(31 * DAY_MS))]);
  const secret = fchannel('staff', [fmsg(A, ago(4 * DAY_MS))], { perms: false });
  const { guild, c } = await build({ channels: [general, random, secret] });

  const stats = await runBackfill({ guild, collector: c, start: new Date(ago(30 * DAY_MS)), upper: c.getGuildState(G).trackingStartedAt });
  assert.equal(stats.messages, 5); // A:3, B:2 (bot, old, post-tracking, no-access excluded)
  assert.equal(stats.reactions, 2); // alice + bob; the bot's reaction excluded
  assert.deepEqual(stats.channelsNoAccess, ['staff']);
  assert.equal(stats.joins, 1); // alice joined 20d ago; bob 40d ago is outside; carol is post-tracking; bots excluded
  assert.ok(c.getGuildState(G).backfilledFrom);

  const guildReport = await reportService.getServerReport({ guild, window: computeWindow(30, 'day', new Date(NOW)), collector: c });
  const r = guildReport.report;
  assert.equal(r.totals.messages, 5);
  assert.equal(r.totals.reactions, 2);
  assert.equal(r.totals.memberJoins, 1);
  assert.equal(r.totals.voiceSessions, 0);
  assert.equal(r.coverage.partial, false, 'backfill covers the whole 30-day window');
  assert.ok(r.coverage.backfilledFrom, 'report knows part of it is backfilled');
  assert.equal(r.activeUsers, 2);
});

test('no double counting: live data stays separate, re-running is a no-op, longer periods only fill the gap', { skip }, async () => {
  const msgs = [fmsg(A, ago(5 * DAY_MS)), fmsg(A, ago(40 * DAY_MS)), fmsg(B, ago(50 * DAY_MS)), fmsg(B, ago(100 * DAY_MS))];
  const { guild, c } = await build({ channels: [fchannel('general', msgs)] });
  // a live message after tracking began
  c.recordMessage({ id: 'live1', guildId: G, author: { id: A, bot: false }, createdTimestamp: ago(1 * HOUR_MS), webhookId: null, system: false });
  await c.flush();

  await runBackfill({ guild, collector: c, start: new Date(ago(30 * DAY_MS)), upper: c.getGuildState(G).trackingStartedAt });
  const total = async (days) => (await reportService.getServerReport({ guild, window: computeWindow(days, 'day', new Date(NOW), 9999), collector: c })).report.totals.messages;
  assert.equal(await total(30), 2); // backfilled (5d) + live (1h)
  reportService.clearCache();

  // second run for a LONGER period: caller passes upper = existing backfilledFrom
  const upper2 = c.getGuildState(G).backfilledFrom;
  await runBackfill({ guild, collector: c, start: new Date(ago(60 * DAY_MS)), upper: upper2 });
  reportService.clearCache();
  assert.equal(await total(60), 4, '40d + 50d messages added once; 100d is out of range; nothing re-counted');
  assert.equal(await total(30), 2, 'the 30-day figure is unchanged by the larger backfill');
});

test('a channel that cannot be read aborts the run and saves nothing', { skip }, async () => {
  const { guild, c } = await build({ channels: [fchannel('ok', [fmsg(A, ago(5 * DAY_MS))]), fchannel('broken', [], { fail: true })] });
  await assert.rejects(() => runBackfill({ guild, collector: c, start: new Date(ago(30 * DAY_MS)), upper: c.getGuildState(G).trackingStartedAt }), /#broken/);
  assert.equal((await getPool().query('SELECT 1 FROM "ActivityHourly"')).rowCount, 0);
  assert.equal(c.getGuildState(G).backfilledFrom, null);
});

test('reaction API budget is enforced and reported', { skip }, async () => {
  const msgs = [2, 3, 4, 5, 6].map((i) => fmsg(A, ago(i * DAY_MS), { reactions: [[bob]] }));
  const { guild, c } = await build({ channels: [fchannel('general', msgs)] });
  const stats = await runBackfill({ guild, collector: c, start: new Date(ago(30 * DAY_MS)), upper: c.getGuildState(G).trackingStartedAt, maxReactionFetches: 2 });
  assert.equal(stats.messages, 5);
  assert.equal(stats.reactions, 2);
  assert.equal(stats.reactionsSkipped, 3);
});

test('/analytics backfill: command flow, already-covered, errors, reports mention the backfill', { skip }, async () => {
  const { guild, c } = await build({ channels: [fchannel('general', [fmsg(A, ago(5 * DAY_MS)), fmsg(B, ago(6 * DAY_MS))])] });
  Object.assign(sharedCollector, { _prisma: shim, log: silentLogger, client: c.client, guildStates: c.guildStates });
  await sharedCollector.loadGuildStates();
  let n = 0;
  const run = async (sub, opts = {}) => {
    const i = fakeInteraction({ guild, member: guild.members.cache.get(ADMIN), sub, opts });
    i.user.id = `adm-${n++}`; // dodge the per-user cooldown
    await analytics.execute(i);
    return i;
  };
  const d = (i) => i.first().embeds[0].data;
  assert.match(d(await run('backfill', { amount: 9, unit: 'year' })).description, /exceeds the maximum/);
  assert.match(d(await run('backfill', { amount: 12, unit: 'hour' })).title, /Already covered/);
  const i = await run('backfill', { amount: 30, unit: 'day' });
  assert.match(d(i).title, /Backfill started/);
  const final = i.last().embeds[0].data;
  assert.match(final.title, /Backfill complete/);
  assert.match(final.description, /Messages recovered: \*\*2\*\*/);
  assert.match(d(await run('backfill', { amount: 30, unit: 'day' })).title, /Already covered/);
  assert.match(d(await run('status')).description, /backfilled from/);
  const rep = (await run('report', { amount: 30, unit: 'day' })).first();
  assert.match(rep.embeds[0].data.description, /backfilled/);
  assert.equal(rep.embeds.length, 2);
});

test('long backfills survive an expired interaction token (falls back to the channel)', { skip }, async () => {
  const { guild, c } = await build({ channels: [fchannel('general', [fmsg(A, ago(5 * DAY_MS))])] });
  Object.assign(sharedCollector, { _prisma: shim, log: silentLogger, client: c.client, guildStates: c.guildStates });
  await sharedCollector.loadGuildStates();
  const i = fakeInteraction({ guild, member: guild.members.cache.get(ADMIN), sub: 'backfill', opts: { amount: 30, unit: 'day' } });
  i.user.id = 'adm-expired';
  let first = true;
  i.editReply = async (p) => { if (first) { first = false; i.calls.push({ kind: 'edit', p }); return {}; } throw Object.assign(new Error('Invalid Webhook Token'), { code: 50027 }); };
  await analytics.execute(i);
  const sent = i.calls.filter((x) => x.kind === 'channel.send');
  assert.equal(sent.length, 1, 'one fallback message, edited afterwards — no channel spam');
  const finalEdit = i.calls.filter((x) => x.kind === 'fallback.edit').at(-1);
  assert.match((finalEdit?.p || sent[0].p).embeds[0].data.title, /Backfill complete/);
});
