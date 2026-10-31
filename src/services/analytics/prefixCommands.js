// "!"-prefixed analytics commands:
//   !<N><unit>active [@member|id]   !leaderboard [period]   !analytics [...]
//
// Admin-only (Discord Administrator permission, or a bot owner), always
// scoped to the guild the command was typed in.

const { AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../../config');
const { isMessageAuthorAdmin } = require('../../utils/permissions');
const { parseActiveCommandToken, parseDuration, computeWindow } = require('./duration');
const { getServerReport, getMemberReport, getLeaderboard, clearCache } = require('./reportService');
const embeds = require('../../utils/analyticsEmbeds');
const { runBackfill, isBackfillRunning } = require('./backfill');

const COOLDOWN_MS = 3000;
const cooldowns = new Map();
const NO_PING = { parse: [], repliedUser: false };

function onCooldown(userId) {
  const now = Date.now();
  const last = cooldowns.get(userId) || 0;
  if (now - last < COOLDOWN_MS) return true;
  cooldowns.set(userId, now);
  if (cooldowns.size > 1000) {
    for (const [k, t] of cooldowns) if (now - t > 60_000) cooldowns.delete(k);
  }
  return false;
}

function channelPerms(message) {
  const me = message.guild.members.me;
  return me ? message.channel.permissionsFor?.(me) : null;
}

async function safeReply(message, payload) {
  try {
    return await message.reply({ ...payload, allowedMentions: NO_PING });
  } catch (err) {
    // 50013 = missing permissions, 50001 = missing access: nothing we can say.
    console.error(`[analytics] could not reply in ${message.guildId}/${message.channelId}:`, err.code || err.message);
    return null;
  }
}

/** Resolves a mention / raw ID argument to a guild member. */
async function resolveMember(message, arg) {
  const m = /^<@!?(\d{17,20})>$/.exec(arg) || /^(\d{17,20})$/.exec(arg);
  if (!m) return { error: `I couldn't read \`${arg.slice(0, 40)}\` as a member. Mention them (\`@name\`) or use their Discord user ID.` };
  const id = m[1];
  try {
    const member = message.guild.members.cache.get(id) || (await message.guild.members.fetch(id));
    if (member.user.bot) return { error: 'Bot accounts aren\u2019t tracked, so there\u2019s no analytics for them.' };
    return { member };
  } catch (err) {
    if (err?.code === 10007 || err?.code === 10013 || /unknown (member|user)/i.test(err?.message || '')) {
      return { error: `I couldn't find a member with ID \`${id}\` in this server.` };
    }
    console.error('[analytics] member lookup failed:', err.message);
    return { error: 'I couldn\u2019t look that member up right now. Please try again.' };
  }
}

async function sendReport(message, embedList, png) {
  const perms = channelPerms(message);
  const canEmbed = !perms || perms.has(PermissionFlagsBits.EmbedLinks);
  const canAttach = !perms || perms.has(PermissionFlagsBits.AttachFiles);
  if (!canEmbed) {
    await safeReply(message, { content: '⚠️ I need the **Embed Links** permission in this channel to show analytics reports.' });
    return;
  }
  if (!png || !canAttach) {
    // No chart: strip the image reference and say why.
    for (const e of embedList) e.setImage(null);
    await safeReply(message, {
      content: png && !canAttach ? '⚠️ I need **Attach Files** to include the activity chart; showing the report without it.' : undefined,
      embeds: embedList,
    });
    return;
  }
  const file = new AttachmentBuilder(Buffer.from(png), { name: embeds.CHART_FILE });
  await safeReply(message, { embeds: embedList, files: [file] });
}

const nf = new Intl.NumberFormat('en-US');

async function handleBackfill(message, args, collector) {
  const prefix = config.analytics.prefix;
  const guild = message.guild;
  const usage = `Usage: \`${prefix}analytics backfill <period>\`, e.g. \`${prefix}analytics backfill 30days\`.`;
  const state = collector.getGuildState(guild.id);
  if (!state?.enabled) {
    return safeReply(message, { embeds: [embeds.errorEmbed(`Enable tracking first with \`${prefix}analytics enable\`, then run the backfill.`)] });
  }
  if (!args.length) return safeReply(message, { embeds: [embeds.errorEmbed(usage)] });
  const parsed = parseDuration(args.join(''));
  if (parsed.error) return safeReply(message, { embeds: [embeds.errorEmbed(`${parsed.error}\n${usage}`)] });
  const window = computeWindow(parsed.amount, parsed.unit, new Date(), config.analytics.maxPeriodDays);
  if (window.error) return safeReply(message, { embeds: [embeds.errorEmbed(window.error)] });
  if (isBackfillRunning(guild.id)) {
    return safeReply(message, { embeds: [embeds.errorEmbed('A backfill is already running for this server.')] });
  }

  // Only the not-yet-covered range before live tracking / a previous backfill.
  const upper = state.backfilledFrom && state.backfilledFrom < state.trackingStartedAt ? state.backfilledFrom : state.trackingStartedAt;
  if (window.start >= upper) {
    return safeReply(message, {
      embeds: [embeds.infoEmbed('✅  Already covered', `Data for **${window.label.toLowerCase()}** already exists (history is available from <t:${Math.floor(upper.getTime() / 1000)}:f>). Nothing to backfill.`)],
    });
  }

  const status = await safeReply(message, {
    embeds: [
      embeds.infoEmbed(
        '📚  Backfill started',
        `Recovering **${window.label.toLowerCase()}** of history (<t:${Math.floor(window.start.getTime() / 1000)}:f> → <t:${Math.floor(upper.getTime() / 1000)}:f>).\n` +
          'This can take a while on busy servers (Discord returns 100 messages per request). Live tracking keeps running; I\u2019ll update this message.'
      ),
    ],
  });

  let lastEdit = 0;
  const onProgress = (p) => {
    const now = Date.now();
    if (!status || now - lastEdit < 10_000) return;
    lastEdit = now;
    status
      .edit({
        embeds: [
          embeds.infoEmbed(
            '📚  Backfill in progress',
            `Phase: **${p.phase}**${p.channel ? ` · #${p.channel}` : ''}\nChannels: **${p.channelsDone}/${p.channelsTotal}** · Messages counted: **${nf.format(p.messages)}** · Reactions: **${nf.format(p.reactions)}**`
          ),
        ],
        allowedMentions: NO_PING,
      })
      .catch(() => {});
  };

  try {
    const r = await runBackfill({ guild, collector, start: window.start, upper, onProgress });
    clearCache();
    const lines = [
      `💬 Messages recovered: **${nf.format(r.messages)}** across **${r.channelsScanned}** channels`,
      `😀 Reactions recovered: **${nf.format(r.reactions)}** *(approximate — see below)*`,
      `📥 Member joins recovered: **${nf.format(r.joins)}** *(current members only)*`,
      '',
      '**Limits**',
      '• Voice activity and member leaves can\u2019t be recovered; they start from live tracking.',
      '• Reactions are the ones that still exist, dated at their message\u2019s time; removed reactions are invisible.',
    ];
    if (r.reactionsSkipped) lines.push(`• ~${nf.format(r.reactionsSkipped)} reactions were skipped to stay within the API budget (\`ANALYTICS_BACKFILL_MAX_REACTION_FETCHES\`).`);
    if (r.channelsNoAccess.length) lines.push(`• No access to ${r.channelsNoAccess.length} channel(s) (need View Channel + Read Message History): ${r.channelsNoAccess.slice(0, 8).map((n) => `#${n}`).join(', ')}${r.channelsNoAccess.length > 8 ? '…' : ''}`);
    lines.push('• Archived threads and deleted messages aren\u2019t included.');
    const done = embeds.infoEmbed('✅  Backfill complete', lines.join('\n'));
    if (status) await status.edit({ embeds: [done], allowedMentions: NO_PING }).catch(() => safeReply(message, { embeds: [done] }));
    else await safeReply(message, { embeds: [done] });
  } catch (err) {
    console.error('[analytics] backfill failed:', err);
    const why = err.userFacing ? `${err.message}. ` : '';
    await safeReply(message, { embeds: [embeds.errorEmbed(`The backfill failed. ${why}Nothing was saved, so it\u2019s safe to run again.`)] });
  }
}

async function handleAnalyticsAdmin(message, args, collector) {
  const sub = (args[0] || 'status').toLowerCase();
  const guild = message.guild;

  if (sub === 'help') return safeReply(message, { embeds: [embeds.helpEmbed(config.analytics.prefix)] });

  if (sub === 'enable') {
    if (collector.isEnabled(guild.id)) {
      return safeReply(message, { embeds: [embeds.infoEmbed('🟢  Already tracking', 'Analytics tracking is already on for this server.')] });
    }
    await collector.enableGuild(guild.id);
    clearCache();
    return safeReply(message, {
      embeds: [
        embeds.infoEmbed(
          '🟢  Analytics enabled',
          'Tracking has started. Reports only include activity from **this moment on** — nothing is back-filled.\nTry `' +
            config.analytics.prefix +
            '1dayactive` later, or `' +
            config.analytics.prefix +
            'analytics help`.'
        ),
      ],
    });
  }

  if (sub === 'disable') {
    if (!collector.isEnabled(guild.id)) {
      return safeReply(message, { embeds: [embeds.infoEmbed('⏸️  Not tracking', 'Analytics tracking is already off for this server.')] });
    }
    await collector.disableGuild(guild.id);
    clearCache();
    return safeReply(message, {
      embeds: [embeds.infoEmbed('⏸️  Analytics paused', 'Tracking stopped. Existing data is kept; run `' + config.analytics.prefix + 'analytics enable` to resume (the gap won\u2019t be filled).')],
    });
  }

  if (sub === 'backfill') return handleBackfill(message, args.slice(1), collector);

  if (sub === 'status') {
    return safeReply(message, {
      embeds: [
        embeds.statusEmbed({
          guild,
          state: collector.getGuildState(guild.id),
          maxDays: config.analytics.maxPeriodDays,
          flushSeconds: config.analytics.flushIntervalSeconds,
          prefixCommands: config.analytics.prefixCommands,
        }),
      ],
    });
  }

  return safeReply(message, { embeds: [embeds.errorEmbed(`Unknown option \`${sub.slice(0, 20)}\`. Try \`${config.analytics.prefix}analytics help\`.`)] });
}

/**
 * Entry point. Returns true if the message was an analytics command
 * (handled or rejected), false if it should be ignored.
 */
async function handleMessageCommand(message, collector) {
  const prefix = config.analytics.prefix;
  if (!message.guild || message.author.bot || !message.content.startsWith(prefix)) return false;

  const parts = message.content.trim().split(/\s+/);
  const first = parts[0];
  const lower = first.toLowerCase();
  const args = parts.slice(1);

  const isLeaderboard = lower === `${prefix}leaderboard`;
  const isAdminCmd = lower === `${prefix}analytics`;
  const duration = !isLeaderboard && !isAdminCmd ? parseActiveCommandToken(first.startsWith(prefix) ? `!${first.slice(prefix.length)}` : first) : null;
  if (!isLeaderboard && !isAdminCmd && duration === null) return false; // not ours

  // ── permissions ──
  if (!isMessageAuthorAdmin(message)) {
    if (!onCooldown(message.author.id)) {
      await safeReply(message, { embeds: [embeds.errorEmbed('🔒 Analytics commands are restricted to server administrators.')] });
    }
    return true;
  }
  if (onCooldown(message.author.id)) return true;

  const perms = channelPerms(message);
  if (perms && !perms.has(PermissionFlagsBits.SendMessages)) return true; // can't speak here

  try {
    if (isAdminCmd) {
      await handleAnalyticsAdmin(message, args, collector);
      return true;
    }

    if (!collector.isEnabled(message.guild.id)) {
      await safeReply(message, {
        embeds: [embeds.infoEmbed('📴  Analytics isn\u2019t enabled here', `Run \`${prefix}analytics enable\` to start collecting activity for this server.`)],
      });
      return true;
    }

    // ── leaderboard ──
    if (isLeaderboard) {
      let amount = config.analytics.leaderboardDefaultDays;
      let unit = 'day';
      if (args.length) {
        const parsed = parseDuration(args.join(''));
        if (parsed.error) {
          await safeReply(message, { embeds: [embeds.errorEmbed(parsed.error)] });
          return true;
        }
        ({ amount, unit } = parsed);
      }
      const window = computeWindow(amount, unit, new Date(), config.analytics.maxPeriodDays);
      if (window.error) {
        await safeReply(message, { embeds: [embeds.errorEmbed(window.error)] });
        return true;
      }
      message.channel.sendTyping?.().catch(() => {});
      const data = await getLeaderboard({ guild: message.guild, window, collector });
      await sendReport(message, [embeds.leaderboardEmbed({ guild: message.guild, ...data })], null);
      return true;
    }

    // ── "<N><unit>active" ──
    if (duration.error) {
      await safeReply(message, { embeds: [embeds.errorEmbed(duration.error)] });
      return true;
    }
    const window = computeWindow(duration.amount, duration.unit, new Date(), config.analytics.maxPeriodDays);
    if (window.error) {
      await safeReply(message, { embeds: [embeds.errorEmbed(window.error)] });
      return true;
    }

    let member = null;
    if (args.length) {
      const res = await resolveMember(message, args[0]);
      if (res.error) {
        await safeReply(message, { embeds: [embeds.errorEmbed(res.error)] });
        return true;
      }
      member = res.member;
    }

    message.channel.sendTyping?.().catch(() => {});
    if (member) {
      const { report, png } = await getMemberReport({ guild: message.guild, member, window, collector });
      await sendReport(message, embeds.memberReportEmbeds(report, message.guild, true), png);
    } else {
      const { report, png } = await getServerReport({ guild: message.guild, window, collector });
      await sendReport(message, embeds.serverReportEmbeds(report, message.guild, true), png);
    }
  } catch (err) {
    console.error('[analytics] command failed:', err);
    await safeReply(message, { embeds: [embeds.errorEmbed('Something went wrong while building that report. Please try again in a moment.')] });
  }
  return true;
}

module.exports = { handleMessageCommand, resolveMember };
