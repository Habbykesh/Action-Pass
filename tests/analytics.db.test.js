const { shim, resetDb, closeDb, getPool, silentLogger, hasDb } = require('./helpers/setup');
const { fakeUser, fakeMember, fakeGuild } = require('./helpers/fakes');
const test = require('node:test');
const assert = require('node:assert/strict');

const skip = hasDb ? false : 'set TEST_DATABASE_URL to run database tests';

const { AnalyticsCollector } = require('../src/services/analytics/collector');
const { computeWindow, HOUR_MS, DAY_MS } = require('../src/services/analytics/duration');
const reportService = require('../src/services/analytics/reportService');

const NOW = new Date('2026-10-30T12:00:00Z');
const G1 = '200000000000000001';
const G2 = '200000000000000002';
const U1 = '300000000000000001', U2 = '300000000000000002', U3 = '300000000000000003', U4 = '300000000000000004', U5 = '300000000000000005', BOT = '300000000000000099';

const clock = { t: NOW.getTime() };
const ago = (ms) => NOW.getTime() - ms;

function newCollector(client = { guilds: { cache: new Map() } }) {
  const c = new AnalyticsCollector({ prisma: shim, logger: silentLogger, now: () => clock.t, flushIntervalMs: 1e9 });
  c.client = client;
  return c;
}
const msg = (id, guildId, userId, at, extra = {}) => ({ id, guildId, author: { id: userId, bot: false }, createdTimestamp: at, webhookId: null, system: false, ...extra });
const reaction = (msgId, guildId, emoji = 'x') => ({ message: { id: msgId, guildId }, emoji: { name: emoji, id: null } });

async function enable(c, guildId, startedAgoMs = 10 * DAY_MS) {
  clock.t = NOW.getTime();
  await c.enableGuild(guildId);
  await getPool().query(`UPDATE "GuildAnalyticsConfig" SET "trackingStartedAt" = $2::timestamp WHERE "guildId" = $1`, [
    guildId,
    new Date(NOW.getTime() - startedAgoMs).toISOString(),
  ]);
  await c.loadGuildStates();
}

const rows = async (sql, params = []) => (await getPool().query(sql, params)).rows;

test.before(async () => { if (hasDb) await resetDb(); });
test.after(async () => { await closeDb(); });
test.beforeEach(async () => {
  if (!hasDb) return;
  await getPool().query('TRUNCATE "ActivityHourly","ActivityMemberEvent","ActivityVoiceSession","GuildAnalyticsConfig" RESTART IDENTITY');
  reportService.clearCache();
  clock.t = NOW.getTime();
});

test('migration created the expected tables and indexes', { skip }, async () => {
  const idx = (await rows(`SELECT indexname FROM pg_indexes WHERE tablename LIKE 'Activity%' ORDER BY 1`)).map((r) => r.indexname);
  for (const name of [
    'ActivityHourly_pkey', 'ActivityHourly_guildId_userId_bucket_idx',
    'ActivityMemberEvent_guildId_occurredAt_idx', 'ActivityMemberEvent_guildId_userId_type_occurredAt_key',
    'ActivityVoiceSession_guildId_userId_endedAt_idx',
  ]) assert.ok(idx.includes(name), `missing index ${name}`);
});

test('period queries use the indexes (guild+time range, guild+member+time)', { skip }, async () => {
  const p = getPool();
  await p.query(`INSERT INTO "ActivityHourly" SELECT '${G1}', 'u' || (g % 50), '2026-01-01'::timestamp + (g || ' hours')::interval, 1, 1, 0, 0 FROM generate_series(1, 5000) g ON CONFLICT DO NOTHING`);
  await p.query('ANALYZE "ActivityHourly"');
  await p.query('SET enable_seqscan = off');
  const plan1 = (await p.query(`EXPLAIN SELECT SUM(messages) FROM "ActivityHourly" WHERE "guildId"='${G1}' AND bucket >= '2026-02-01' AND bucket <= '2026-02-10'`)).rows.map((r) => r['QUERY PLAN']).join('\n');
  const plan2 = (await p.query(`EXPLAIN SELECT SUM(messages) FROM "ActivityHourly" WHERE "guildId"='${G1}' AND "userId"='u1' AND bucket >= '2026-02-01' AND bucket <= '2026-02-10'`)).rows.map((r) => r['QUERY PLAN']).join('\n');
  await p.query('RESET enable_seqscan');
  assert.match(plan1, /Index/); assert.match(plan2, /Index/);
});

test('only enabled guilds are tracked; bots/webhooks/system/DM/duplicates excluded', { skip }, async () => {
  const c = newCollector();
  assert.equal(c.recordMessage(msg('m0', G1, U1, ago(HOUR_MS))), false, 'disabled guild must not track');
  await enable(c, G1);
  assert.equal(c.recordMessage(msg('m1', G1, U1, ago(HOUR_MS))), true);
  assert.equal(c.recordMessage(msg('m1', G1, U1, ago(HOUR_MS))), false, 'duplicate message id');
  assert.equal(c.recordMessage({ ...msg('m2', G1, BOT, ago(HOUR_MS)), author: { id: BOT, bot: true } }), false, 'bot');
  assert.equal(c.recordMessage(msg('m3', G1, U1, ago(HOUR_MS), { webhookId: 'w' })), false, 'webhook');
  assert.equal(c.recordMessage(msg('m4', G1, U1, ago(HOUR_MS), { system: true })), false, 'system');
  assert.equal(c.recordMessage(msg('m5', null, U1, ago(HOUR_MS))), false, 'DM');
  assert.equal(c.recordReaction(reaction('m1', G1), fakeUser(U2, 'u2')), true);
  assert.equal(c.recordReaction(reaction('m1', G1), fakeUser(U2, 'u2')), false, 'replayed reaction');
  assert.equal(c.recordReaction(reaction('m1', G1, 'y'), fakeUser(U2, 'u2')), true, 'different emoji is a different reaction');
  assert.equal(c.recordReaction(reaction('m1', G1), fakeUser(BOT, 'bot', true)), false, 'bot reaction');
  await c.flush();
  const r = await rows(`SELECT "userId", messages, reactions FROM "ActivityHourly" ORDER BY "userId"`);
  assert.deepEqual(r.map((x) => [x.userId, x.messages, x.reactions]), [[U1, 1, 0], [U2, 0, 2]]);
});

test('flush accumulates into existing rows and survives a "restart"', { skip }, async () => {
  const c1 = newCollector();
  await enable(c1, G1);
  c1.recordMessage(msg('a1', G1, U1, ago(HOUR_MS)));
  c1.recordMessage(msg('a2', G1, U1, ago(HOUR_MS)));
  await c1.flush();
  c1.recordMessage(msg('a3', G1, U1, ago(HOUR_MS)));
  await c1.flush();
  assert.equal((await rows(`SELECT messages FROM "ActivityHourly"`))[0].messages, 3);

  // brand-new process: state comes back from Postgres
  const c2 = newCollector();
  await c2.loadGuildStates();
  assert.equal(c2.isEnabled(G1), true);
  c2.recordMessage(msg('a4', G1, U1, ago(HOUR_MS)));
  await c2.flush();
  assert.equal((await rows(`SELECT messages FROM "ActivityHourly"`))[0].messages, 4);
  const { report } = await reportService.getServerReport({ guild: fakeGuild(G1, 'One', [fakeMember(U1, 'u1')]), window: computeWindow(1, 'day', NOW), collector: c2 });
  assert.equal(report.totals.messages, 4);
});

test('a failed flush keeps the counters and retries without loss or double-count', { skip }, async () => {
  let fail = true;
  const flaky = { $queryRaw: shim.$queryRaw, $executeRaw: (...a) => (fail ? Promise.reject(new Error('db down')) : shim.$executeRaw(...a)) };
  const c = new AnalyticsCollector({ prisma: shim, logger: silentLogger, now: () => clock.t, flushIntervalMs: 1e9 });
  c.client = { guilds: { cache: new Map() } };
  await enable(c, G1);
  c._prisma = flaky;
  c.recordMessage(msg('f1', G1, U1, ago(HOUR_MS)));
  c.recordMessage(msg('f2', G1, U1, ago(HOUR_MS)));
  await c.flush();
  assert.equal((await rows(`SELECT 1 FROM "ActivityHourly"`)).length, 0);
  fail = false;
  c.recordMessage(msg('f3', G1, U1, ago(HOUR_MS)));
  await c.flush();
  assert.equal((await rows(`SELECT messages FROM "ActivityHourly"`))[0].messages, 3);
  await c.flush();
  assert.equal((await rows(`SELECT messages FROM "ActivityHourly"`))[0].messages, 3, 'no double count');
});

const vs = (guild, userId, channelId) => ({ guild, channelId, member: fakeMember(userId, 'v' + userId), id: userId });

test('voice: sessions split across hours, moves/mutes ignored, heartbeat + close never double count', { skip }, async () => {
  const guild = fakeGuild(G1, 'One');
  const c = newCollector({ guilds: { cache: new Map([[G1, guild]]) } });
  await enable(c, G1);

  clock.t = Date.parse('2026-10-30T10:15:00Z');
  c.onVoiceStateUpdate(vs(guild, U1, null), vs(guild, U1, 'vc1'));        // join
  clock.t = Date.parse('2026-10-30T10:30:00Z');
  await c.flush();                                                         // heartbeat credits 900s
  c.onVoiceStateUpdate(vs(guild, U1, 'vc1'), vs(guild, U1, 'vc1'));        // mute toggle: ignored
  clock.t = Date.parse('2026-10-30T10:40:00Z');
  c.onVoiceStateUpdate(vs(guild, U1, 'vc1'), vs(guild, U1, 'vc2'));        // move: same session
  clock.t = Date.parse('2026-10-30T11:45:00Z');
  c.onVoiceStateUpdate(vs(guild, U1, 'vc2'), vs(guild, U1, null));        // leave
  await c.flush();

  const r = await rows(`SELECT to_char(bucket,'HH24') h, "voiceJoins" j, "voiceSeconds" s FROM "ActivityHourly" ORDER BY bucket`);
  assert.deepEqual(r.map((x) => [x.h, x.j, x.s]), [['10', 1, 2700], ['11', 0, 2700]]);
  const s = await rows(`SELECT "channelId", "endedAt" IS NOT NULL ended FROM "ActivityVoiceSession"`);
  assert.equal(s.length, 1); assert.equal(s[0].ended, true);

  // bots and the AFK channel are not counted
  c.onVoiceStateUpdate(vs(guild, 'b', null), { ...vs(guild, 'b', 'vc1'), member: fakeMember('b', 'bot', { bot: true }) });
  c.onVoiceStateUpdate(vs(guild, U2, null), vs(guild, U2, 'afk-1'));
  assert.equal(c.sessions.size, 0);
});

test('voice: restart closes orphaned sessions at last heartbeat and resumes live ones without crediting downtime', { skip }, async () => {
  const guild = fakeGuild(G1, 'One');
  const c1 = newCollector({ guilds: { cache: new Map([[G1, guild]]) } });
  await enable(c1, G1);
  clock.t = Date.parse('2026-10-30T09:00:00Z');
  c1.onVoiceStateUpdate(vs(guild, U1, null), vs(guild, U1, 'vc1'));
  c1.onVoiceStateUpdate(vs(guild, U2, null), vs(guild, U2, 'vc1'));
  clock.t = Date.parse('2026-10-30T09:10:00Z');
  await c1.flush(); // heartbeat at 09:10 → 600s each credited
  // --- crash: nothing else flushed. Bot comes back at 11:00. ---
  clock.t = Date.parse('2026-10-30T11:00:00Z');
  const guild2 = fakeGuild(G1, 'One');
  guild2.voiceStates.cache.set(U2, { id: U2, channelId: 'vc1', member: fakeMember(U2, 'u2') }); // U2 still in voice, U1 left
  const c2 = newCollector({ guilds: { cache: new Map([[G1, guild2]]) } });
  await c2.loadGuildStates();
  await c2.reconcileVoiceSessions();
  await c2.flush();

  const sess = await rows(`SELECT "userId", to_char("endedAt",'HH24:MI') e FROM "ActivityVoiceSession" ORDER BY "userId"`);
  assert.deepEqual(sess.map((x) => [x.userId, x.e]), [[U1, '09:10'], [U2, null]]);
  assert.equal(c2.sessions.has(`${G1}|${U2}`), true, 'live session resumed');
  const secs = await rows(`SELECT "userId", SUM("voiceSeconds")::int s FROM "ActivityHourly" GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(secs.map((x) => [x.userId, x.s]), [[U1, 600], [U2, 600]], 'downtime 09:10→11:00 was not invented');
});

test('member joins/leaves: bots excluded, replayed join is a no-op', { skip }, async () => {
  const c1 = newCollector();
  await enable(c1, G1);
  const guild = { id: G1 };
  const join = { guild, id: U4, user: { bot: false }, joinedTimestamp: ago(5 * HOUR_MS) };
  assert.equal(await c1.recordMemberJoin(join), true);
  assert.equal(await c1.recordMemberJoin(join), false);
  const c2 = newCollector(); await c2.loadGuildStates();
  await c2.recordMemberJoin(join); // replay after reconnect in a fresh process → DB unique key
  assert.equal(await c1.recordMemberJoin({ ...join, id: BOT, user: { bot: true } }), false);
  clock.t = ago(26 * HOUR_MS);
  await c1.recordMemberLeave({ guild, id: U5, user: { bot: false } });
  const e = await rows(`SELECT "userId", type FROM "ActivityMemberEvent" ORDER BY type`);
  assert.deepEqual(e.map((x) => [x.userId, x.type]), [[U4, 'join'], [U5, 'leave']]);
});

async function seedScenario(c, guildId = G1) {
  await enable(c, guildId);
  for (let i = 0; i < 10; i++) c.recordMessage(msg(`${guildId}-u1-${i}`, guildId, U1, ago(2 * HOUR_MS)));
  clock.t = ago(2 * HOUR_MS);
  for (let i = 0; i < 5; i++) c.recordReaction(reaction(`${guildId}-r${i}`, guildId), fakeUser(U1, 'u1'));
  clock.t = ago(3 * HOUR_MS);
  c.onVoiceStateUpdate(vs(c.client.guilds.cache.get(guildId), U1, null), vs(c.client.guilds.cache.get(guildId), U1, 'vc1'));
  clock.t = ago(2.5 * HOUR_MS);
  c.onVoiceStateUpdate(vs(c.client.guilds.cache.get(guildId), U1, 'vc1'), vs(c.client.guilds.cache.get(guildId), U1, null));
  for (let i = 0; i < 4; i++) c.recordMessage(msg(`${guildId}-u2-${i}`, guildId, U2, ago(30 * HOUR_MS)));
  clock.t = ago(30 * HOUR_MS);
  for (let i = 0; i < 2; i++) c.recordReaction(reaction(`${guildId}-q${i}`, guildId), fakeUser(U2, 'u2'));
  c.recordMessage(msg(`${guildId}-u3-0`, guildId, U3, ago(100 * HOUR_MS)));
  await c.recordMemberJoin({ guild: { id: guildId }, id: U4, user: { bot: false }, joinedTimestamp: ago(5 * HOUR_MS) });
  clock.t = ago(26 * HOUR_MS);
  await c.recordMemberLeave({ guild: { id: guildId }, id: U5, user: { bot: false } });
  clock.t = NOW.getTime();
  await c.flush();
}

function guildWithMembers(id, name) {
  return fakeGuild(id, name, [fakeMember(U1, 'alice'), fakeMember(U2, 'bob'), fakeMember(U3, 'carol'), fakeMember(U4, 'dave')]);
}

test('server report: exact totals, engagement definition, breakdown = 100%', { skip }, async () => {
  const guild = guildWithMembers(G1, 'One');
  const c = newCollector({ guilds: { cache: new Map([[G1, guild]]) } });
  await seedScenario(c);
  const { report, png } = await reportService.getServerReport({ guild, window: computeWindow(7, 'day', NOW), collector: c });
  assert.equal(report.totals.messages, 15);
  assert.equal(report.totals.reactions, 7);
  assert.equal(report.totals.voiceSessions, 1);
  assert.equal(report.totals.voiceSeconds, 1800);
  assert.equal(report.totals.memberJoins, 1);
  assert.equal(report.totals.memberLeaves, 1);
  assert.equal(report.activeUsers, 3);
  assert.equal(report.engagements, 15 + 7 + 1, 'messages + reactions + voice sessions, joins/leaves excluded');
  assert.equal(report.avgMessagesPerActive, 5);
  assert.ok(Math.abs(report.avgReactionsPerActive - 7 / 3) < 1e-9);
  assert.equal(report.activityRate, (3 / 4) * 100);
  assert.deepEqual(report.breakdown.counts, [15, 7, 1, 1, 1]);
  assert.equal(Math.round(report.breakdown.percents.reduce((a, b) => a + b, 0) * 10) / 10, 100);
  assert.equal(report.peak.active, 1);
  assert.equal(report.coverage.partial, false);
  assert.equal(report.chart.reduce((a, p) => a + p.engagements, 0), 23, 'chart sums back to the total');
  assert.equal(report.chart.reduce((a, p) => a + p.joins, 0), 1);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('short window (24h, hourly buckets) only includes that window', { skip }, async () => {
  const guild = guildWithMembers(G1, 'One');
  const c = newCollector({ guilds: { cache: new Map([[G1, guild]]) } });
  await seedScenario(c);
  const { report } = await reportService.getServerReport({ guild, window: computeWindow(24, 'hour', NOW), collector: c });
  assert.equal(report.intervals.chart, 'hour');
  assert.equal(report.totals.messages, 10);
  assert.equal(report.totals.reactions, 5);
  assert.equal(report.activeUsers, 1);
  assert.equal(report.totals.memberLeaves, 0, 'leave 26h ago is outside 24h');
  assert.equal(report.totals.memberJoins, 1);
  assert.equal(report.chart.length, 25);
});

test('individual report uses only that member, counts reactions GIVEN', { skip }, async () => {
  const guild = guildWithMembers(G1, 'One');
  const c = newCollector({ guilds: { cache: new Map([[G1, guild]]) } });
  await seedScenario(c);
  const a = await reportService.getMemberReport({ guild, member: guild.members.cache.get(U1), window: computeWindow(7, 'day', NOW), collector: c });
  assert.equal(a.report.messages, 10); assert.equal(a.report.reactions, 5);
  assert.equal(a.report.voiceSessions, 1); assert.equal(a.report.voiceSeconds, 1800);
  assert.equal(a.report.engagements, 16);
  assert.equal(a.report.user.id, U1);
  const b = await reportService.getMemberReport({ guild, member: guild.members.cache.get(U2), window: computeWindow(7, 'day', NOW), collector: c });
  assert.equal(b.report.messages, 4); assert.equal(b.report.reactions, 2); assert.equal(b.report.voiceSessions, 0);
  assert.equal(b.report.mostActiveDay.engagements, 6);
  const nobody = await reportService.getMemberReport({ guild, member: fakeMember(U5, 'ghost'), window: computeWindow(7, 'day', NOW), collector: c });
  assert.equal(nobody.report.isEmpty, true);
});

test('multiple servers are fully independent', { skip }, async () => {
  const g1 = guildWithMembers(G1, 'One');
  const g2 = fakeGuild(G2, 'Two', [fakeMember(U1, 'alice'), fakeMember(U5, 'eve')]);
  const c = newCollector({ guilds: { cache: new Map([[G1, g1], [G2, g2]]) } });
  await seedScenario(c, G1);
  await enable(c, G2, 3 * DAY_MS);
  for (let i = 0; i < 7; i++) c.recordMessage(msg(`g2-${i}`, G2, U5, ago(HOUR_MS)));
  await c.flush();
  const r1 = await reportService.getServerReport({ guild: g1, window: computeWindow(7, 'day', NOW), collector: c });
  const r2 = await reportService.getServerReport({ guild: g2, window: computeWindow(7, 'day', NOW), collector: c });
  assert.equal(r1.report.totals.messages, 15);
  assert.equal(r2.report.totals.messages, 7);
  assert.equal(r2.report.activeUsers, 1);
  const lb2 = await reportService.getLeaderboard({ guild: g2, window: computeWindow(30, 'day', NOW), collector: c });
  assert.deepEqual(lb2.rows.map((x) => x.userId), [U5], 'G1 users never leak into G2');
  const m2 = await reportService.getMemberReport({ guild: g2, member: g2.members.cache.get(U1), window: computeWindow(7, 'day', NOW), collector: c });
  assert.equal(m2.report.messages, 0, 'U1 activity in G1 is invisible from G2');
});

test('leaderboard: ranked by documented score, excludes members who left', { skip }, async () => {
  const guild = guildWithMembers(G1, 'One');
  const c = newCollector({ guilds: { cache: new Map([[G1, guild]]) } });
  await seedScenario(c);
  guild.members.cache.delete(U3); // carol left the server
  const lb = await reportService.getLeaderboard({ guild, window: computeWindow(30, 'day', NOW), collector: c });
  assert.deepEqual(lb.rows.map((x) => x.userId), [U1, U2]);
  // alice: 10 msgs + 5×0.5 reactions + 30 voice min × 0.2 = 18.5 ; bob: 4 + 2×0.5 = 5
  assert.equal(lb.rows[0].score, 18.5); assert.equal(lb.rows[1].score, 5);
  assert.deepEqual([lb.rows[0].messages, lb.rows[0].reactions, lb.rows[0].voiceSeconds], [10, 5, 1800]);
  // not ranked by messages alone: lots of reactions + voice can outrank more messages
  const c2 = newCollector({ guilds: { cache: new Map([[G1, guild]]) } });
  await c2.loadGuildStates();
  for (let i = 0; i < 30; i++) c2.recordReaction(reaction(`lbx${i}`, G1, 'e' + i), fakeUser(U2, 'bob'));
  await c2.flush(); reportService.clearCache();
  const lb2 = await reportService.getLeaderboard({ guild, window: computeWindow(30, 'day', NOW), collector: c2 });
  assert.equal(lb2.rows[0].userId, U2, 'bob (5 + 30 reactions x 0.5 = 20) now outranks alice (18.5) despite far fewer messages');
});

test('empty and partial periods are reported honestly', { skip }, async () => {
  const guild = guildWithMembers(G1, 'One');
  const c = newCollector({ guilds: { cache: new Map([[G1, guild]]) } });
  await enable(c, G1, 2 * DAY_MS);
  c.recordMessage(msg('p1', G1, U1, ago(5 * HOUR_MS)));
  await c.flush();
  const partial = await reportService.getServerReport({ guild, window: computeWindow(30, 'day', NOW), collector: c });
  assert.equal(partial.report.coverage.partial, true);
  assert.ok(Math.abs(partial.report.coverage.coveredFraction - 2 / 30) < 0.001);
  assert.equal(partial.report.totals.messages, 1);

  reportService.clearCache();
  const empty = await reportService.getServerReport({ guild, window: computeWindow(1, 'hour', new Date(NOW.getTime() - 20 * DAY_MS)), collector: c });
  assert.equal(empty.report.coverage.noData, true);
  assert.equal(empty.report.isEmpty, true);
  assert.equal(empty.report.activeUsers, 0);
  assert.ok(empty.png.length > 1000, 'a chart is still produced');

  reportService.clearCache();
  const quiet = await reportService.getServerReport({ guild, window: computeWindow(1, 'hour', NOW), collector: c });
  assert.equal(quiet.report.totals.messages, 0);
  assert.equal(quiet.report.isEmpty, true);
});

test('long windows aggregate weekly and stay readable', { skip }, async () => {
  const guild = guildWithMembers(G1, 'One');
  const c = newCollector({ guilds: { cache: new Map([[G1, guild]]) } });
  await enable(c, G1, 400 * DAY_MS);
  await getPool().query(
    `INSERT INTO "ActivityHourly" SELECT $1, 'u' || (d % 7), $2::timestamp - (d || ' days')::interval, 2, 1, 0, 0 FROM generate_series(0, 364) d`,
    [G1, new Date(NOW.getTime() - 3 * HOUR_MS).toISOString()]
  );
  const { report } = await reportService.getServerReport({ guild, window: computeWindow(1, 'year', NOW), collector: c });
  assert.equal(report.intervals.chart, 'week');
  assert.ok(report.chart.length <= 54, `weekly points: ${report.chart.length}`);
  assert.equal(report.totals.messages, 365 * 2);
  assert.equal(report.chart.reduce((a, p) => a + p.messages, 0), 365 * 2);
  assert.equal(report.activeUsers, 7);
  const r365 = await reportService.getServerReport({ guild, window: computeWindow(365, 'day', NOW), collector: c });
  assert.equal(r365.report.totals.messages, 365 * 2);
});

test('disable pauses tracking and closes voice sessions; re-enable records the pause', { skip }, async () => {
  const guild = fakeGuild(G1, 'One');
  const c = newCollector({ guilds: { cache: new Map([[G1, guild]]) } });
  await enable(c, G1);
  clock.t = ago(2 * HOUR_MS);
  c.onVoiceStateUpdate(vs(guild, U1, null), vs(guild, U1, 'vc1'));
  clock.t = ago(1 * HOUR_MS);
  await c.disableGuild(G1);
  await c.sessionWrites;
  assert.equal(c.isEnabled(G1), false);
  assert.equal(c.recordMessage(msg('d1', G1, U1, ago(HOUR_MS))), false);
  assert.equal((await rows(`SELECT SUM("voiceSeconds")::int s FROM "ActivityHourly"`))[0].s, 3600);
  assert.equal((await rows(`SELECT 1 FROM "ActivityVoiceSession" WHERE "endedAt" IS NULL`)).length, 0);
  clock.t = NOW.getTime();
  await c.enableGuild(G1);
  const st = c.getGuildState(G1);
  assert.ok(st.pausedFrom && st.pausedTo && st.pausedTo > st.pausedFrom);
});
