// The logic behind /analytics. Slash commands need no privileged intent.
// Everything is scoped to interaction.guild and runs after the caller has
// been checked as a server administrator (see commands/analytics.js).

const { AttachmentBuilder } = require('discord.js');
const config = require('../../config');
const { computeWindow } = require('./duration');
const { getServerReport, getMemberReport, getLeaderboard, clearCache } = require('./reportService');
const { runBackfill, isBackfillRunning } = require('./backfill');
const embeds = require('../../utils/analyticsEmbeds');

const NO_PING = { parse: [], repliedUser: false };
const nf = new Intl.NumberFormat('en-US');
const unix = (d) => Math.floor(d.getTime() / 1000);

/**
 * Wraps an interaction as a tiny reply API. The interaction must already
 * be deferred. `reply` edits the deferred response first, then follows up.
 * The returned handle's edit() falls back to a normal channel message
 * once Discord's 15-minute interaction token has expired (long backfills).
 */
function makeCtx(interaction) {
  let first = true;
  let fallback = null; // channel message used once the interaction token expires
  const edit = async (payload) => {
    const body = { ...payload, allowedMentions: NO_PING };
    if (fallback) return fallback.edit(body).catch(() => {});
    try {
      return await interaction.editReply(body);
    } catch (err) {
      fallback = (await interaction.channel?.send?.(body)) || null;
      return fallback;
    }
  };
  return {
    guild: interaction.guild,
    async reply(payload) {
      const body = { ...payload, allowedMentions: NO_PING };
      if (first) {
        first = false;
        await interaction.editReply(body);
      } else {
        await interaction.followUp(body);
      }
      return { edit };
    },
  };
}

async function safeReply(ctx, payload) {
  try {
    return await ctx.reply(payload);
  } catch (err) {
    console.error('[analytics] could not reply:', err.code || err.message);
    return null;
  }
}

async function sendReport(ctx, embedList, png) {
  if (!png) {
    for (const e of embedList) e.setImage(null);
    await safeReply(ctx, { embeds: embedList });
    return;
  }
  const file = new AttachmentBuilder(Buffer.from(png), { name: embeds.CHART_FILE });
  await safeReply(ctx, { embeds: embedList, files: [file] });
}

function windowOr(ctx, amount, unit) {
  const w = computeWindow(amount, unit, new Date(), config.analytics.maxPeriodDays);
  if (w.error) return { error: w.error };
  return { window: w };
}

async function resolveMember(guild, user) {
  if (user.bot) return { error: 'Bot accounts aren\u2019t tracked, so there\u2019s no analytics for them.' };
  try {
    const member = guild.members.cache.get(user.id) || (await guild.members.fetch(user.id));
    return { member };
  } catch (err) {
    if (err?.code === 10007 || err?.code === 10013 || /unknown (member|user)/i.test(err?.message || '')) {
      return { error: `I couldn't find <@${user.id}> (\`${user.id}\`) in this server.` };
    }
    console.error('[analytics] member lookup failed:', err.message);
    return { error: 'I couldn\u2019t look that member up right now. Please try again.' };
  }
}

function notEnabled(ctx) {
  return safeReply(ctx, {
    embeds: [embeds.infoEmbed('📴  Analytics isn\u2019t enabled here', 'Run `/analytics enable` to start collecting activity for this server.')],
  });
}

async function runReport(ctx, collector, { amount, unit, user }) {
  if (!collector.isEnabled(ctx.guild.id)) return notEnabled(ctx);
  const { window, error } = windowOr(ctx, amount, unit);
  if (error) return safeReply(ctx, { embeds: [embeds.errorEmbed(error)] });

  if (user) {
    const res = await resolveMember(ctx.guild, user);
    if (res.error) return safeReply(ctx, { embeds: [embeds.errorEmbed(res.error)] });
    const { report, png } = await getMemberReport({ guild: ctx.guild, member: res.member, window, collector });
    return sendReport(ctx, embeds.memberReportEmbeds(report, ctx.guild, true), png);
  }
  const { report, png } = await getServerReport({ guild: ctx.guild, window, collector });
  return sendReport(ctx, embeds.serverReportEmbeds(report, ctx.guild, true), png);
}

async function runLeaderboard(ctx, collector, { amount, unit }) {
  if (!collector.isEnabled(ctx.guild.id)) return notEnabled(ctx);
  const { window, error } = windowOr(ctx, amount ?? config.analytics.leaderboardDefaultDays, unit ?? 'day');
  if (error) return safeReply(ctx, { embeds: [embeds.errorEmbed(error)] });
  const data = await getLeaderboard({ guild: ctx.guild, window, collector });
  return sendReport(ctx, [embeds.leaderboardEmbed({ guild: ctx.guild, ...data })], null);
}

async function runBackfillCommand(ctx, collector, { amount, unit }) {
  const guild = ctx.guild;
  const state = collector.getGuildState(guild.id);
  if (!state?.enabled) {
    return safeReply(ctx, { embeds: [embeds.errorEmbed('Enable tracking first with `/analytics enable`, then run the backfill.')] });
  }
  const { window, error } = windowOr(ctx, amount, unit);
  if (error) return safeReply(ctx, { embeds: [embeds.errorEmbed(error)] });
  if (isBackfillRunning(guild.id)) return safeReply(ctx, { embeds: [embeds.errorEmbed('A backfill is already running for this server.')] });

  // Only the not-yet-covered range before live tracking / a previous backfill.
  const upper = state.backfilledFrom && state.backfilledFrom < state.trackingStartedAt ? state.backfilledFrom : state.trackingStartedAt;
  if (window.start >= upper) {
    return safeReply(ctx, {
      embeds: [embeds.infoEmbed('✅  Already covered', `Data for **${window.label.toLowerCase()}** already exists (history is available from <t:${unix(upper)}:f>). Nothing to backfill.`)],
    });
  }

  const status = await safeReply(ctx, {
    embeds: [
      embeds.infoEmbed(
        '📚  Backfill started',
        `Recovering **${window.label.toLowerCase()}** of history (<t:${unix(window.start)}:f> → <t:${unix(upper)}:f>).\n` +
          'This can take a while on busy servers (Discord returns 100 messages per request). Live tracking keeps running; I\u2019ll update this message.'
      ),
    ],
  });

  let lastEdit = 0;
  const onProgress = (p) => {
    const now = Date.now();
    if (!status || now - lastEdit < 10_000) return;
    lastEdit = now;
    Promise.resolve(
      status.edit({
        embeds: [
          embeds.infoEmbed(
            '📚  Backfill in progress',
            `Phase: **${p.phase}**${p.channel ? ` · #${p.channel}` : ''}\nChannels: **${p.channelsDone}/${p.channelsTotal}** · Messages counted: **${nf.format(p.messages)}** · Reactions: **${nf.format(p.reactions)}**`
          ),
        ],
      })
    ).catch(() => {});
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
    if (r.channelsNoAccess.length) {
      lines.push(`• No access to ${r.channelsNoAccess.length} channel(s) (need View Channel + Read Message History): ${r.channelsNoAccess.slice(0, 8).map((n) => `#${n}`).join(', ')}${r.channelsNoAccess.length > 8 ? '…' : ''}`);
    }
    lines.push('• Archived threads and deleted messages aren\u2019t included.');
    const done = embeds.infoEmbed('✅  Backfill complete', lines.join('\n'));
    if (status) await status.edit({ embeds: [done] });
    else await safeReply(ctx, { embeds: [done] });
  } catch (err) {
    console.error('[analytics] backfill failed:', err);
    const why = err.userFacing ? `${err.message}. ` : '';
    await safeReply(ctx, { embeds: [embeds.errorEmbed(`The backfill failed. ${why}Nothing was saved, so it\u2019s safe to run again.`)] });
  }
}

async function runAdmin(ctx, collector, sub) {
  const guild = ctx.guild;
  if (sub === 'help') return safeReply(ctx, { embeds: [embeds.helpEmbed()] });

  if (sub === 'enable') {
    if (collector.isEnabled(guild.id)) {
      return safeReply(ctx, { embeds: [embeds.infoEmbed('🟢  Already tracking', 'Analytics tracking is already on for this server.')] });
    }
    await collector.enableGuild(guild.id);
    clearCache();
    return safeReply(ctx, {
      embeds: [embeds.infoEmbed('🟢  Analytics enabled', 'Tracking has started. Live data begins **now**; run `/analytics backfill` to recover earlier messages.')],
    });
  }

  if (sub === 'disable') {
    if (!collector.isEnabled(guild.id)) {
      return safeReply(ctx, { embeds: [embeds.infoEmbed('⏸️  Not tracking', 'Analytics tracking is already off for this server.')] });
    }
    await collector.disableGuild(guild.id);
    clearCache();
    return safeReply(ctx, {
      embeds: [embeds.infoEmbed('⏸️  Analytics paused', 'Tracking stopped. Existing data is kept; run `/analytics enable` to resume (the gap won\u2019t be filled).')],
    });
  }

  return safeReply(ctx, {
    embeds: [
      embeds.statusEmbed({
        guild,
        state: collector.getGuildState(guild.id),
        maxDays: config.analytics.maxPeriodDays,
        flushSeconds: config.analytics.flushIntervalSeconds,
      }),
    ],
  });
}

module.exports = { makeCtx, runReport, runLeaderboard, runBackfillCommand, runAdmin, safeReply };
