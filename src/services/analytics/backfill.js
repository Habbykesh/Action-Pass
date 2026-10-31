// Recovers PAST activity from Discord's own history so reports can look
// back before tracking started.
//
// What can be recovered (and how it is labelled):
//  • Messages — exact author + timestamp, read from channel history.
//  • Member joins — from each current member's joinedAt (people who joined
//    and already left are gone).
//  • Reactions — APPROXIMATE: Discord keeps no reaction history, so we count
//    the reactions that still exist and date them at the message's time.
//    Removed reactions are invisible. Capped by an API-call budget.
//  • Voice and member leaves — NOT recoverable; they start at live tracking.
//
// Only the range BEFORE live tracking (or before an earlier backfill) is
// filled, so nothing is ever counted twice. Results are aggregated in
// memory and committed at the end, so an interrupted run changes nothing
// and can simply be re-run.

const { PermissionFlagsBits } = require('discord.js');
const config = require('../../config');
const { HOUR_MS } = require('./duration');

const DISCORD_EPOCH = 1420070400000n;
const running = new Set();

function snowflakeFromMs(ms) {
  return String((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function isBackfillRunning(guildId) {
  return running.has(guildId);
}

function scannableChannels(guild) {
  const me = guild.members.me;
  const all = [...guild.channels.cache.values()];
  const ok = [];
  const skipped = [];
  for (const ch of all) {
    if (!ch.isTextBased?.() || ch.isDMBased?.()) continue;
    const perms = me ? ch.permissionsFor?.(me) : null;
    if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      skipped.push(ch);
      continue;
    }
    ok.push(ch);
  }
  return { ok, skipped };
}

/**
 * @param {object} o
 * @param {object} o.guild
 * @param {object} o.collector       AnalyticsCollector
 * @param {Date}   o.start           oldest moment to recover
 * @param {Date}   o.upper           exclusive upper bound (start of already-covered data)
 * @param {function} [o.onProgress]  ({phase, channel, channelsDone, channelsTotal, messages, reactions})
 */
async function runBackfill({ guild, collector, start, upper, onProgress: rawProgress = () => {}, maxReactionFetches = config.analytics.backfillMaxReactionFetches }) {
  if (running.has(guild.id)) throw new Error('A backfill is already running for this server.');
  running.add(guild.id);
  const startMs = start.getTime();
  const upperMs = upper.getTime();
  const log = collector.log || console;
  const onProgress = (p) => {
    try {
      rawProgress(p);
    } catch {
      /* progress display must never break a backfill */
    }
  };

  try {
    const rows = new Map(); // `${userId}|${bucketMs}` -> row
    const add = (userId, tsMs, field) => {
      const bucketMs = Math.floor(tsMs / HOUR_MS) * HOUR_MS;
      const key = `${userId}|${bucketMs}`;
      let r = rows.get(key);
      if (!r) {
        r = { guildId: guild.id, userId, bucketMs, messages: 0, reactions: 0, voiceJoins: 0, voiceSeconds: 0 };
        rows.set(key, r);
      }
      r[field] += 1;
    };

    const stats = { messages: 0, reactions: 0, joins: 0, reactionFetches: 0, reactionsSkipped: 0, channelsScanned: 0, channelsFailed: [], channelsNoAccess: [] };
    const { ok: channels, skipped } = scannableChannels(guild);
    stats.channelsNoAccess = skipped.map((c) => c.name);

    // ── messages (+ approximate reactions) ──
    let done = 0;
    for (const ch of channels) {
      onProgress({ phase: 'messages', channel: ch.name, channelsDone: done, channelsTotal: channels.length, messages: stats.messages, reactions: stats.reactions });
      try {
        // Start paging just below `upper` so newer (already tracked) messages are never fetched.
        let before = snowflakeFromMs(upperMs);
        let finished = false;
        while (!finished) {
          const batch = await ch.messages.fetch({ limit: 100, before });
          if (!batch.size) break;
          let oldest = null;
          for (const m of batch.values()) {
            const ts = m.createdTimestamp;
            if (!oldest || ts < oldest.createdTimestamp) oldest = m;
            if (ts < startMs) { finished = true; continue; }
            if (ts >= upperMs) continue;
            if (!m.author || m.author.bot || m.webhookId || m.system) continue;
            add(m.author.id, ts, 'messages');
            stats.messages++;

            if (m.reactions?.cache?.size) {
              for (const reaction of m.reactions.cache.values()) {
                if (stats.reactionFetches >= maxReactionFetches) { stats.reactionsSkipped += reaction.count || 1; continue; }
                stats.reactionFetches++;
                try {
                  let after;
                  let remaining = reaction.count || 100;
                  while (remaining > 0) {
                    const users = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
                    if (!users.size) break;
                    for (const u of users.values()) {
                      if (!u.bot) { add(u.id, ts, 'reactions'); stats.reactions++; }
                    }
                    remaining -= users.size;
                    if (users.size < 100) break;
                    after = [...users.keys()].pop();
                  }
                } catch (err) {
                  stats.reactionsSkipped += reaction.count || 1;
                  log.error?.(`[analytics] backfill reaction fetch failed in #${ch.name}:`, err.message);
                }
              }
            }
          }
          if (batch.size < 100 || !oldest) break;
          before = oldest.id;
        }
        stats.channelsScanned++;
      } catch (err) {
        stats.channelsFailed.push(ch.name);
        log.error?.(`[analytics] backfill failed in #${ch.name}:`, err.message);
      }
      done++;
    }

    // Never save a half-finished range: `backfilledFrom` would then claim
    // coverage the failed channels don't have, and a re-run couldn't fix it.
    if (stats.channelsFailed.length) {
      const err = new Error(`Could not read: ${stats.channelsFailed.slice(0, 8).map((n) => `#${n}`).join(', ')}${stats.channelsFailed.length > 8 ? '…' : ''}`);
      err.userFacing = true;
      throw err;
    }

    // ── member joins ──
    onProgress({ phase: 'members', channelsDone: done, channelsTotal: channels.length, messages: stats.messages, reactions: stats.reactions });
    let members = guild.members.cache;
    try {
      if (!guild.memberCount || members.size < guild.memberCount * 0.95) members = await guild.members.fetch();
    } catch (err) {
      log.error?.('[analytics] backfill member fetch failed, using cache:', err.message);
    }
    const joinRows = [];
    for (const m of members.values()) {
      const t = m.joinedTimestamp;
      if (!t || m.user?.bot || t < startMs || t >= upperMs) continue;
      joinRows.push([m.id, iso(t)]);
    }

    // ── commit (additive; only the pre-tracking range, so no double counting) ──
    onProgress({ phase: 'saving', channelsDone: done, channelsTotal: channels.length, messages: stats.messages, reactions: stats.reactions });
    await collector.upsertHourly([...rows.values()]);
    for (let i = 0; i < joinRows.length; i += 2000) {
      const part = joinRows.slice(i, i + 2000);
      await collector.prisma.$executeRaw`
        INSERT INTO "ActivityMemberEvent" ("guildId", "userId", "type", "occurredAt")
        SELECT ${guild.id}, t.u, 'join', t.at::timestamp
        FROM unnest(${part.map((p) => p[0])}::text[], ${part.map((p) => p[1])}::text[]) AS t(u, at)
        ON CONFLICT ("guildId", "userId", "type", "occurredAt") DO NOTHING`;
    }
    stats.joins = joinRows.length;
    await collector.setBackfilledFrom(guild.id, start);
    return stats;
  } finally {
    running.delete(guild.id);
  }
}

module.exports = { runBackfill, isBackfillRunning, snowflakeFromMs };
