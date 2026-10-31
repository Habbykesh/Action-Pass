// Continuous activity collection.
//
// Design:
//  - Discord events only touch in-memory counters (O(1), synchronous), so
//    tracking can never slow the event loop down.
//  - Counters are flushed to Postgres every few seconds as ONE batched
//    upsert into the hourly rollup table, not one write per event.
//  - Voice sessions are persisted (start / heartbeat / end) so a restart
//    or crash never loses or invents voice time: orphaned sessions are
//    closed at the last heartbeat, never later.
//  - Bots, webhooks, system messages and DMs are never counted.
//  - Duplicates (gateway resume replays) are filtered with short-lived
//    in-memory ID sets; member joins are additionally protected by a
//    unique key in the database.

const config = require('../../config');
const { HOUR_MS } = require('./duration');

const MAX_PENDING_KEYS = 50_000; // memory safety if the DB is down for a long time

class RecentKeys {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  /** Returns true if the key was already seen. */
  seen(key) {
    if (this.map.has(key)) return true;
    this.map.set(key, 1);
    if (this.map.size > this.maxSize) {
      // Maps iterate in insertion order → drop the oldest ~10%.
      let toDrop = Math.ceil(this.maxSize * 0.1);
      for (const k of this.map.keys()) {
        this.map.delete(k);
        if (--toDrop <= 0) break;
      }
    }
    return false;
  }
}

function floorHour(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

class AnalyticsCollector {
  constructor({ prisma = null, logger = console, now = () => Date.now(), flushIntervalMs } = {}) {
    this._prisma = prisma;
    this.log = logger;
    this.sessionWrites = Promise.resolve(); // keeps voice-session DB writes in order
    this.now = now;
    this.flushIntervalMs = flushIntervalMs ?? config.analytics.flushIntervalSeconds * 1000;

    this.guildStates = new Map(); // guildId -> {enabled, trackingStartedAt, pausedFrom, pausedTo}
    this.counters = new Map(); // `${guildId}|${userId}|${bucketMs}` -> row
    this.sessions = new Map(); // `${guildId}|${userId}` -> {channelId, startedAt, creditedUntil}
    this.seenMessages = new RecentKeys(20_000);
    this.seenReactions = new RecentKeys(20_000);
    this.seenMemberEvents = new RecentKeys(5_000);

    this.timer = null;
    this.flushing = null;
    this.client = null;
  }

  // Lazy so merely importing this module never constructs a Prisma client.
  get prisma() {
    if (!this._prisma) this._prisma = require('../../database/connect').prisma;
    return this._prisma;
  }

  /** Voice-session DB writes must apply in the order they were issued. */
  queueSessionWrite(fn) {
    this.sessionWrites = this.sessionWrites
      .then(fn)
      .catch((err) => this.log.error('[analytics] voice session write failed:', err.message));
    return this.sessionWrites;
  }

  // ── guild state ──────────────────────────────────────────────────

  isEnabled(guildId) {
    return this.guildStates.get(guildId)?.enabled === true;
  }

  getGuildState(guildId) {
    return this.guildStates.get(guildId) || null;
  }

  async loadGuildStates() {
    const rows = await this.prisma.$queryRaw`
      SELECT "guildId",
             "enabled",
             to_char("trackingStartedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "trackingStartedAt",
             to_char("pausedFrom", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "pausedFrom",
             to_char("pausedTo", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "pausedTo",
             to_char("backfilledFrom", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "backfilledFrom"
      FROM "GuildAnalyticsConfig"`;
    this.guildStates.clear();
    for (const r of rows) {
      this.guildStates.set(r.guildId, {
        enabled: r.enabled,
        trackingStartedAt: new Date(r.trackingStartedAt),
        pausedFrom: r.pausedFrom ? new Date(r.pausedFrom) : null,
        pausedTo: r.pausedTo ? new Date(r.pausedTo) : null,
        backfilledFrom: r.backfilledFrom ? new Date(r.backfilledFrom) : null,
      });
    }
  }

  /** Turns tracking on. Idempotent. Never back-fills. */
  async enableGuild(guildId) {
    const nowIso = iso(this.now());
    await this.prisma.$executeRaw`
      INSERT INTO "GuildAnalyticsConfig" ("guildId", "enabled", "trackingStartedAt", "updatedAt")
      VALUES (${guildId}, true, ${nowIso}::timestamp, ${nowIso}::timestamp)
      ON CONFLICT ("guildId") DO UPDATE SET
        "enabled" = true,
        "pausedTo" = CASE WHEN "GuildAnalyticsConfig"."enabled" = false
                          THEN EXCLUDED."updatedAt" ELSE "GuildAnalyticsConfig"."pausedTo" END,
        "updatedAt" = EXCLUDED."updatedAt"`;
    await this.loadGuildStates();
    if (this.client) this.openVoiceSessionsFromCache(guildId);
  }

  /** Stops tracking (data is kept). Closes open voice sessions first. */
  async disableGuild(guildId) {
    const state = this.guildStates.get(guildId);
    if (!state?.enabled) return;
    const nowMs = this.now();
    for (const key of [...this.sessions.keys()]) {
      if (key.startsWith(`${guildId}|`)) this.closeSession(key, nowMs);
    }
    await this.flush();
    const nowIso = iso(nowMs);
    await this.prisma.$executeRaw`
      UPDATE "GuildAnalyticsConfig"
      SET "enabled" = false, "pausedFrom" = ${nowIso}::timestamp, "pausedTo" = NULL, "updatedAt" = ${nowIso}::timestamp
      WHERE "guildId" = ${guildId}`;
    await this.loadGuildStates();
  }

  // ── counters ─────────────────────────────────────────────────────

  addCounter(guildId, userId, bucketMs, field, amount) {
    if (!amount) return;
    const key = `${guildId}|${userId}|${bucketMs}`;
    let row = this.counters.get(key);
    if (!row) {
      if (this.counters.size >= MAX_PENDING_KEYS) {
        // Database has been unreachable for a long time: shed the oldest
        // entries rather than grow without bound.
        const oldest = this.counters.keys().next().value;
        this.counters.delete(oldest);
        this.log.error('[analytics] pending counter buffer full; dropping oldest entry');
      }
      row = { guildId, userId, bucketMs, messages: 0, reactions: 0, voiceJoins: 0, voiceSeconds: 0 };
      this.counters.set(key, row);
    }
    row[field] += amount;
  }

  // ── event recorders (all synchronous) ────────────────────────────

  recordMessage(message) {
    const guildId = message.guildId;
    if (!guildId || !this.isEnabled(guildId)) return false;
    if (!message.author || message.author.bot || message.webhookId || message.system) return false;
    if (this.seenMessages.seen(message.id)) return false;
    const at = message.createdTimestamp || this.now();
    this.addCounter(guildId, message.author.id, floorHour(at), 'messages', 1);
    return true;
  }

  recordReaction(reaction, user) {
    const guildId = reaction.message?.guildId || reaction.message?.guild?.id;
    if (!guildId || !this.isEnabled(guildId)) return false;
    if (!user || user.bot) return false;
    const emojiKey = reaction.emoji?.id || reaction.emoji?.name || '?';
    if (this.seenReactions.seen(`${reaction.message.id}:${user.id}:${emojiKey}`)) return false;
    this.addCounter(guildId, user.id, floorHour(this.now()), 'reactions', 1);
    return true;
  }

  async recordMemberJoin(member) {
    if (!member?.guild || member.user?.bot || !this.isEnabled(member.guild.id)) return false;
    // Discord's own joinedAt makes this idempotent across reconnects.
    const at = member.joinedTimestamp || this.now();
    return this.insertMemberEvent(member.guild.id, member.id, 'join', at);
  }

  async recordMemberLeave(member) {
    if (!member?.guild || member.user?.bot || !this.isEnabled(member.guild.id)) return false;
    return this.insertMemberEvent(member.guild.id, member.id, 'leave', this.now());
  }

  async insertMemberEvent(guildId, userId, type, atMs) {
    // Same member + type within the same second is a duplicate delivery.
    if (this.seenMemberEvents.seen(`${guildId}:${userId}:${type}:${Math.floor(atMs / 1000)}`)) return false;
    const at = iso(atMs);
    await this.prisma.$executeRaw`
      INSERT INTO "ActivityMemberEvent" ("guildId", "userId", "type", "occurredAt")
      VALUES (${guildId}, ${userId}, ${type}, ${at}::timestamp)
      ON CONFLICT ("guildId", "userId", "type", "occurredAt") DO NOTHING`;
    return true;
  }

  // ── voice ────────────────────────────────────────────────────────

  isCountableChannel(guild, channelId) {
    return Boolean(channelId) && channelId !== guild?.afkChannelId;
  }

  onVoiceStateUpdate(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    const member = newState.member || oldState.member;
    if (!guild || !this.isEnabled(guild.id)) return;
    if (!member || member.user?.bot) return;

    const wasIn = this.isCountableChannel(guild, oldState.channelId);
    const nowIn = this.isCountableChannel(guild, newState.channelId);
    const key = `${guild.id}|${member.id}`;
    const nowMs = this.now();

    if (!wasIn && nowIn) {
      this.openSession(guild.id, member.id, newState.channelId, nowMs, true);
    } else if (wasIn && !nowIn) {
      this.closeSession(key, nowMs);
    } else if (wasIn && nowIn && oldState.channelId !== newState.channelId) {
      // Moving between channels is the same continuous session.
      const s = this.sessions.get(key);
      if (s) s.channelId = newState.channelId;
    }
    // Mute / deafen / stream toggles in the same channel: ignored.
  }

  openSession(guildId, userId, channelId, startMs, countJoin) {
    const key = `${guildId}|${userId}`;
    if (this.sessions.has(key)) return; // already tracking (reconnect / duplicate event)
    this.sessions.set(key, { channelId, startedAt: startMs, creditedUntil: startMs });
    if (countJoin) this.addCounter(guildId, userId, floorHour(startMs), 'voiceJoins', 1);
    const startedIso = iso(startMs);
    this.queueSessionWrite(
      () => this.prisma.$executeRaw`
        INSERT INTO "ActivityVoiceSession" ("guildId", "userId", "channelId", "startedAt", "lastSeenAt")
        VALUES (${guildId}, ${userId}, ${channelId}, ${startedIso}::timestamp, ${startedIso}::timestamp)`
    );
  }

  /** Credits whole seconds since creditedUntil into the right hour buckets. */
  creditSession(guildId, userId, session, untilMs) {
    let cursor = session.creditedUntil;
    while (cursor < untilMs) {
      const hourStart = floorHour(cursor);
      const sliceEnd = Math.min(hourStart + HOUR_MS, untilMs);
      const secs = Math.floor((sliceEnd - cursor) / 1000);
      if (secs > 0) {
        this.addCounter(guildId, userId, hourStart, 'voiceSeconds', secs);
        cursor += secs * 1000;
      } else if (sliceEnd === untilMs) {
        break;
      } else {
        cursor = sliceEnd;
      }
    }
    session.creditedUntil = cursor;
  }

  closeSession(key, endMs) {
    const session = this.sessions.get(key);
    if (!session) return;
    const [guildId, userId] = key.split('|');
    this.creditSession(guildId, userId, session, endMs);
    this.sessions.delete(key);
    const endIso = iso(endMs);
    this.queueSessionWrite(
      () => this.prisma.$executeRaw`
        UPDATE "ActivityVoiceSession"
        SET "endedAt" = ${endIso}::timestamp, "lastSeenAt" = ${endIso}::timestamp
        WHERE "guildId" = ${guildId} AND "userId" = ${userId} AND "endedAt" IS NULL`
    );
  }

  openVoiceSessionsFromCache(guildId) {
    const guild = this.client?.guilds?.cache?.get(guildId);
    if (!guild) return;
    const nowMs = this.now();
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId || !this.isCountableChannel(guild, vs.channelId)) continue;
      if (vs.member?.user?.bot) continue;
      // We never saw these members join, so no join is counted — only
      // time from this moment on.
      this.openSession(guildId, vs.id, vs.channelId, nowMs, false);
    }
  }

  /**
   * Called once after the gateway is ready. Closes sessions orphaned by
   * a restart/crash and resumes the ones that are demonstrably still live.
   */
  async reconcileVoiceSessions() {
    const rows = await this.prisma.$queryRaw`
      SELECT "guildId", "userId", "channelId",
             to_char("startedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",
             to_char("lastSeenAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt"
      FROM "ActivityVoiceSession" WHERE "endedAt" IS NULL`;
    const nowMs = this.now();
    for (const r of rows) {
      const guild = this.client?.guilds?.cache?.get(r.guildId);
      const vs = guild?.voiceStates?.cache?.get(r.userId);
      const stillLive = this.isEnabled(r.guildId) && vs?.channelId && this.isCountableChannel(guild, vs.channelId);
      const key = `${r.guildId}|${r.userId}`;
      if (stillLive && !this.sessions.has(key)) {
        // Resume. The downtime gap is NOT credited — we can't prove they
        // were there for it.
        this.sessions.set(key, { channelId: vs.channelId, startedAt: new Date(r.startedAt).getTime(), creditedUntil: nowMs });
      } else if (!stillLive) {
        await this.prisma.$executeRaw`
          UPDATE "ActivityVoiceSession" SET "endedAt" = ${r.lastSeenAt}::timestamp
          WHERE "guildId" = ${r.guildId} AND "userId" = ${r.userId} AND "endedAt" IS NULL`;
      }
    }
    for (const [guildId, state] of this.guildStates) {
      if (state.enabled) this.openVoiceSessionsFromCache(guildId);
    }
  }

  // ── flushing ─────────────────────────────────────────────────────

  async heartbeatVoice() {
    const nowMs = this.now();
    for (const [key, session] of this.sessions) {
      const [guildId, userId] = key.split('|');
      this.creditSession(guildId, userId, session, nowMs);
    }
  }

  /** Serialised: concurrent callers share one in-flight flush. */
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async doFlush() {
    await this.heartbeatVoice();

    const batch = [...this.counters.values()];
    this.counters = new Map();

    if (batch.length) {
      try {
        await this.upsertHourly(batch);
      } catch (err) {
        // Put the batch back so nothing is lost; retried on the next tick.
        for (const row of err.remaining || batch) {
          const key = `${row.guildId}|${row.userId}|${row.bucketMs}`;
          const existing = this.counters.get(key);
          if (existing) {
            for (const f of ['messages', 'reactions', 'voiceJoins', 'voiceSeconds']) existing[f] += row[f];
          } else {
            this.counters.set(key, row);
          }
        }
        this.log.error('[analytics] flush failed, will retry:', err.message);
        return;
      }
    }

    // Heartbeat AFTER the counters are safely stored: lastSeenAt never
    // runs ahead of the voice time that has actually been recorded.
    if (this.sessions.size) {
      const entries = [...this.sessions.entries()].map(([key, s]) => ({
        guildId: key.split('|')[0],
        userId: key.split('|')[1],
        at: iso(s.creditedUntil),
      }));
      try {
        await this.sessionWrites;
        await this.prisma.$executeRaw`
          UPDATE "ActivityVoiceSession" s SET "lastSeenAt" = v.at::timestamp
          FROM unnest(
            ${entries.map((e) => e.guildId)}::text[],
            ${entries.map((e) => e.userId)}::text[],
            ${entries.map((e) => e.at)}::text[]
          ) AS v(g, u, at)
          WHERE s."guildId" = v.g AND s."userId" = v.u AND s."endedAt" IS NULL`;
      } catch (err) {
        this.log.error('[analytics] voice heartbeat failed:', err.message);
      }
    }
  }

  /** Additive batched upsert into the hourly rollup. Rows: {guildId,userId,bucketMs,messages,reactions,voiceJoins,voiceSeconds}. */
  async upsertHourly(batch) {
    for (let i = 0; i < batch.length; i += 5000) {
      const part = batch.slice(i, i + 5000);
      try {
        await this.upsertChunk(part);
      } catch (err) {
        err.remaining = batch.slice(i); // chunks before this one are already committed
        throw err;
      }
    }
  }

  async upsertChunk(part) {
    {
      await this.prisma.$executeRaw`
        INSERT INTO "ActivityHourly" ("guildId", "userId", "bucket", "messages", "reactions", "voiceJoins", "voiceSeconds")
        SELECT t.g, t.u, t.b::timestamp, t.m, t.r, t.vj, t.vs
        FROM unnest(
          ${part.map((r) => r.guildId)}::text[],
          ${part.map((r) => r.userId)}::text[],
          ${part.map((r) => iso(r.bucketMs))}::text[],
          ${part.map((r) => r.messages || 0)}::int[],
          ${part.map((r) => r.reactions || 0)}::int[],
          ${part.map((r) => r.voiceJoins || 0)}::int[],
          ${part.map((r) => r.voiceSeconds || 0)}::int[]
        ) AS t(g, u, b, m, r, vj, vs)
        ON CONFLICT ("guildId", "bucket", "userId") DO UPDATE SET
          "messages" = "ActivityHourly"."messages" + EXCLUDED."messages",
          "reactions" = "ActivityHourly"."reactions" + EXCLUDED."reactions",
          "voiceJoins" = "ActivityHourly"."voiceJoins" + EXCLUDED."voiceJoins",
          "voiceSeconds" = "ActivityHourly"."voiceSeconds" + EXCLUDED."voiceSeconds"`;
    }
  }

  async setBackfilledFrom(guildId, date) {
    await this.prisma.$executeRaw`
      UPDATE "GuildAnalyticsConfig" SET "backfilledFrom" = ${iso(date.getTime())}::timestamp WHERE "guildId" = ${guildId}`;
    await this.loadGuildStates();
  }

  // ── lifecycle ────────────────────────────────────────────────────

  async init(client) {
    this.client = client;
    await this.loadGuildStates();

    // Opt-in per guild; the bot owner's own servers are switched on once.
    for (const guildId of config.analytics.autoEnableGuildIds) {
      if (!this.guildStates.has(guildId)) {
        await this.enableGuild(guildId);
      }
    }

    await this.reconcileVoiceSessions();

    if (!this.timer) {
      this.timer = setInterval(() => {
        this.flush().catch((err) => this.log.error('[analytics] flush error:', err.message));
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Flush everything; leave voice sessions open so a restart resumes them. */
  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.flush();
    } catch (err) {
      this.log.error('[analytics] final flush failed:', err.message);
    }
  }
}

const collector = new AnalyticsCollector();

module.exports = { AnalyticsCollector, RecentKeys, collector };
