const { shim, resetDb, closeDb, getPool, silentLogger, hasDb } = require('./helpers/setup');
const { fakeUser, fakeMember, fakeGuild, fakeInteraction } = require('./helpers/fakes');
const test = require('node:test');
const assert = require('node:assert/strict');

const skip = hasDb ? false : 'set TEST_DATABASE_URL to run command tests';

const { AnalyticsCollector } = require('../src/services/analytics/collector');
const analytics = require('../src/commands/analytics');
const { collector: sharedCollector } = require('../src/services/analytics/collector');
const reportService = require('../src/services/analytics/reportService');

const G = '400000000000000001';
const ADMIN = '500000000000000001', MEMBER = '500000000000000002', OTHER = '500000000000000003', BOTID = '500000000000000004', GHOST = '500000000000000077';

let guild, collector, n = 0;

async function setup() {
  await getPool().query('TRUNCATE "ActivityHourly","ActivityMemberEvent","ActivityVoiceSession","GuildAnalyticsConfig" RESTART IDENTITY');
  reportService.clearCache();
  guild = fakeGuild(G, 'Test Guild', [
    fakeMember(ADMIN, 'adminuser', { admin: true }),
    fakeMember(MEMBER, 'regular'),
    fakeMember(OTHER, 'chatty'),
    fakeMember(BOTID, 'somebot', { bot: true }),
  ]);
  // the command uses the app-wide collector; point it at the test DB + fake client
  Object.assign(sharedCollector, { _prisma: shim, log: silentLogger, client: { guilds: { cache: new Map([[G, guild]]) } } });
  collector = sharedCollector;
  collector.guildStates.clear(); collector.counters.clear(); collector.sessions.clear(); collector.seenReactions.map.clear(); collector.seenMessages.map.clear();
  await collector.enableGuild(G);
  for (let i = 0; i < 6; i++) collector.recordMessage({ id: `s${n++}`, guildId: G, author: { id: OTHER, bot: false }, createdTimestamp: Date.now() - 60_000, webhookId: null, system: false });
  collector.recordReaction({ message: { id: 'mm', guildId: G }, emoji: { name: 'x' } }, fakeUser(OTHER, 'chatty'));
  await collector.flush();
}

let cd = 0;
async function run(sub, opts = {}, { as = ADMIN, owner = false } = {}) {
  const member = guild.members.cache.get(as);
  const i = fakeInteraction({ guild, member, sub, opts, owner });
  i.user.id = `${i.user.id}-${cd++}`; // dodge the per-user cooldown (permissions come from member)
  if (owner) i.user.id = process.env.OWNER_IDS.split(',')[0] + '';
  await analytics.execute(i);
  return i;
}
const desc = (p) => p.embeds[0].data.description;

test.before(async () => { if (hasDb) await resetDb(); });
test.after(async () => { await closeDb(); });

test('command definition: admin-only default, guild-only, expected subcommands', () => {
  const j = analytics.data.toJSON();
  assert.equal(j.name, 'analytics');
  assert.equal(BigInt(j.default_member_permissions), 8n); // Administrator
  assert.equal(j.dm_permission, false);
  assert.deepEqual(j.options.map((o) => o.name).sort(), ['backfill', 'disable', 'enable', 'help', 'leaderboard', 'report', 'status']);
  const report = j.options.find((o) => o.name === 'report');
  assert.deepEqual(report.options.find((o) => o.name === 'unit').choices.map((c) => c.value), ['hour', 'day', 'week', 'month', 'year']);
});

test('non-admins are denied everything', { skip }, async () => {
  await setup();
  for (const [sub, opts] of [['report', { amount: 7, unit: 'day' }], ['leaderboard', {}], ['status', {}], ['enable', {}], ['backfill', { amount: 1, unit: 'day' }]]) {
    const i = await run(sub, opts, { as: MEMBER });
    assert.match(i.calls[0].p.content, /restricted to server administrators/, sub);
    assert.equal(i.calls[0].p.ephemeral, true);
  }
});

test('admin gets a 2-embed server report with a chart attachment', { skip }, async () => {
  await setup();
  const i = await run('report', { amount: 14, unit: 'day' });
  const p = i.first();
  assert.equal(p.embeds.length, 2);
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].name, 'analytics-chart.png');
  const e1 = p.embeds[0].data, e2 = p.embeds[1].data;
  assert.match(e1.title, /Server Analytics — Test Guild/);
  assert.match(e1.description, /Last 14 days/);
  const names = e1.fields.map((f) => f.name).join('|');
  for (const want of ['Server Overview', 'Activity Totals', 'Activity Analysis', 'Engagement Metrics']) assert.match(names, new RegExp(want));
  assert.match(e2.fields.map((f) => f.name).join('|'), /Activity Breakdown.*Server Status/);
  assert.equal(e2.image.url, 'attachment://analytics-chart.png');
  assert.ok(e2.timestamp);
  for (const e of p.embeds) assert.ok(JSON.stringify(e).length < 6000);
  assert.match(e1.fields[0].value, /Active users: \*\*1\*\*/);
  assert.match(e1.fields[1].value, /Messages: \*\*6\*\*/);
  assert.equal(i.calls[0].kind, 'defer');
});

test('every unit works, including singular amounts, months and years', { skip }, async () => {
  await setup();
  for (const [amount, unit] of [[6, 'hour'], [1, 'hour'], [1, 'day'], [5, 'day'], [2, 'week'], [1, 'week'], [4, 'month'], [1, 'month'], [1, 'year'], [180, 'day'], [365, 'day']]) {
    const i = await run('report', { amount, unit });
    assert.equal(i.first().embeds.length, 2, `${amount} ${unit}`);
  }
  assert.match(desc(await (await run('report', { amount: 1, unit: 'day' })).first()), /Last 1 day\b/);
});

test('periods beyond the configured maximum are rejected clearly', { skip }, async () => {
  await setup();
  assert.match(desc((await run('report', { amount: 5, unit: 'year' })).first()), /exceeds the maximum/);
  assert.match(desc((await run('leaderboard', { amount: 99999, unit: 'day' })).first()), /exceeds the maximum/);
});

test('member reports: by mention/ID (user option), clear errors otherwise', { skip }, async () => {
  await setup();
  const i = await run('report', { amount: 7, unit: 'day', member: fakeUser(OTHER, 'chatty') });
  const e = i.first().embeds[0].data;
  assert.equal(i.first().embeds.length, 1);
  assert.match(e.title, /Member Analytics — chatty/);
  assert.match(e.description, new RegExp(OTHER));
  assert.match(e.fields[0].value, /Messages sent: \*\*6\*\*/);
  assert.match(e.fields[0].value, /Reactions given: \*\*1\*\*/);
  assert.match(desc((await run('report', { amount: 7, unit: 'day', member: fakeUser(GHOST, 'ghost') })).first()), /couldn't find/);
  assert.match(desc((await run('report', { amount: 7, unit: 'day', member: fakeUser(BOTID, 'somebot', true) })).first()), /Bot accounts/);
  assert.match(JSON.stringify((await run('report', { amount: 7, unit: 'day', member: fakeUser(MEMBER, 'regular') })).first().embeds[0].data), /No activity from this member/);
});

test('leaderboard: default 30 days, optional period, formula shown, bots excluded', { skip }, async () => {
  await setup();
  const e = (await run('leaderboard')).first().embeds[0].data;
  assert.match(e.description, /Last 30 days/);
  assert.match(e.description, /chatty/);
  assert.doesNotMatch(e.description, /somebot/);
  assert.match(e.fields[0].value, /messages × 1 \+ reactions × 0.5 \+ voice minutes × 0.2/);
  assert.match((await run('leaderboard', { amount: 2, unit: 'week' })).first().embeds[0].data.description, /Last 2 weeks/);
});

test('enable / disable / status / help; reports refuse when tracking is off', { skip }, async () => {
  await setup();
  const d = (i) => i.first().embeds[0].data;
  assert.match(d(await run('status')).description, /Tracking is ON/);
  assert.match(d(await run('disable')).title, /paused/);
  assert.match(d(await run('report', { amount: 7, unit: 'day' })).title, /isn.t enabled/);
  assert.match(d(await run('status')).description, /paused/);
  assert.match(d(await run('enable')).title, /enabled/);
  assert.equal((await run('report', { amount: 7, unit: 'day' })).first().embeds.length, 2);
  assert.match(d(await run('help')).description, /Definitions/);
  assert.equal((await run('status')).calls[0].p.ephemeral, true, 'admin chatter is private by default');
});

test('private option and bot-owner access; database errors do not crash', { skip }, async () => {
  await setup();
  assert.equal((await run('report', { amount: 1, unit: 'day', private: true })).calls[0].p.ephemeral, true);
  assert.equal((await run('report', { amount: 1, unit: 'day' })).calls[0].p.ephemeral, false);
  assert.equal((await run('report', { amount: 1, unit: 'day' }, { as: MEMBER, owner: true })).first().embeds.length, 2);
  const real = collector._prisma;
  collector._prisma = { $queryRaw: () => Promise.reject(new Error('boom')), $executeRaw: () => Promise.reject(new Error('boom')) };
  reportService.clearCache();
  const i = await run('report', { amount: 3, unit: 'day' });
  assert.match(desc(i.first()), /Something went wrong/);
  collector._prisma = real;
});

test('cooldown stops rapid repeat heavy commands from the same user', { skip }, async () => {
  await setup();
  const member = guild.members.cache.get(ADMIN);
  const mk = () => fakeInteraction({ guild, member, sub: 'report', opts: { amount: 1, unit: 'day' } });
  const a = mk(); a.user.id = 'cooldown-user'; await analytics.execute(a);
  const b = mk(); b.user.id = 'cooldown-user'; await analytics.execute(b);
  assert.match(b.calls[0].p.content, /wait a few seconds/);
});
