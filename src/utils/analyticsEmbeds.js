const { EmbedBuilder } = require('discord.js');
const { formatDuration, trendLabel } = require('../services/analytics/report');
const { DAY_MS } = require('../services/analytics/duration');

const COLOR = 0x8b5cf6; // same violet as the rest of Action Pass
const COLOR_WARN = 0xfee75c;
const COLOR_FAIL = 0xed4245;
const FOOTER = 'Action Pass Analytics';
const CHART_FILE = 'analytics-chart.png';

const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => nf.format(Math.round(n));
const fmt1 = (n) => nf.format(Math.round(n * 10) / 10);
const unix = (d) => Math.floor(d.getTime() / 1000);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(d, withTime) {
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return withTime ? `${base}, ${String(d.getUTCHours()).padStart(2, '0')}:00 UTC` : `${base} (UTC)`;
}

function bar(pct, width = 10) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function periodBlock(report) {
  const { window, coverage } = report;
  const lines = [
    `**Period:** ${window.label}`,
    `🕒 <t:${unix(window.start)}:f> → <t:${unix(window.end)}:f> · times in UTC`,
    '*Data is stored per hour, so the start of the period is rounded down to the hour.*',
  ];
  if (coverage.backfilledFrom && coverage.started) {
    lines.push(
      '',
      `📚 History was backfilled from <t:${unix(coverage.backfilledFrom)}:f>: messages, joins and *approximate* reactions only. Voice and member leaves are recorded from <t:${unix(coverage.started)}:f> onward.`
    );
  }
  if (coverage.noData) {
    lines.push('', '⚠️ **No tracking data yet for this period** — analytics only count activity from the moment tracking was enabled.');
  } else if (coverage.partial) {
    const pct = Math.round(coverage.coveredFraction * 100);
    lines.push(
      '',
      `⚠️ **Partial data** — ${pct}% of this period is covered (data begins <t:${unix(coverage.effectiveStart)}:f>). Earlier activity isn't available, so it isn't shown. Admins can run \`/analytics backfill\` to recover past messages.`
    );
  }
  if (coverage.pauseOverlaps) {
    const to = coverage.pausedTo ? `<t:${unix(coverage.pausedTo)}:f>` : 'now';
    lines.push(`⏸️ Tracking was paused from <t:${unix(coverage.pausedFrom)}:f> to ${to}; activity in that gap wasn't recorded.`);
  }
  return lines.join('\n');
}

function guildStatusText(guild) {
  const feats = guild.features || [];
  const flags = [];
  if (feats.includes('VERIFIED')) flags.push('✅ Verified');
  if (feats.includes('PARTNERED')) flags.push('🤝 Partnered');
  if (feats.includes('COMMUNITY')) flags.push('🏘️ Community');
  const verification = ['None', 'Low', 'Medium', 'High', 'Highest'][guild.verificationLevel] ?? String(guild.verificationLevel);
  const channels = guild.channels?.cache;
  const all = channels ? [...channels.values()] : [];
  const voice = all.filter((c) => c.isVoiceBased?.()).length;
  const text = all.filter((c) => c.isTextBased?.() && !c.isVoiceBased?.() && !c.isThread?.()).length;
  return [
    `${guild.available === false ? '🔴 Unavailable (Discord outage)' : '🟢 Available'}`,
    `📅 Created <t:${unix(guild.createdAt)}:D>`,
    `💎 Boost tier ${guild.premiumTier ?? 0} · ${guild.premiumSubscriptionCount ?? 0} boosts`,
    `🔐 Verification level: ${verification}`,
    `💬 ${text} text · 🔊 ${voice} voice · 🎭 ${guild.roles?.cache?.size ?? 0} roles`,
    flags.length ? flags.join(' · ') : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function serverReportEmbeds(report, guild, hasChart) {
  const { totals } = report;
  const peakUnit = report.intervals.stat === 'hour' ? 'hour' : 'day';

  const e1 = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`📊  Server Analytics — ${guild.name}`.slice(0, 256))
    .setDescription(periodBlock(report))
    .addFields(
      {
        name: '🏠  Server Overview',
        value: [
          `👥 Members: **${fmt(report.memberCount)}** *(incl. bots)*`,
          `⚡ Active users: **${fmt(report.activeUsers)}**`,
          `📶 Activity rate: **${report.activityRate === null ? 'n/a' : `${fmt1(report.activityRate)}%`}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📬  Activity Totals',
        value: [
          `💬 Messages: **${fmt(totals.messages)}**`,
          `😀 Reactions: **${fmt(totals.reactions)}**`,
          `🔊 Voice sessions: **${fmt(totals.voiceSessions)}** *(${formatDuration(totals.voiceSeconds)})*`,
          `📥 Joins: **${fmt(totals.memberJoins)}**`,
          `📤 Leaves: **${fmt(totals.memberLeaves)}**`,
        ].join('\n'),
        inline: true,
      },
      { name: '\u200b', value: '\u200b', inline: false },
      {
        name: '📈  Activity Analysis',
        value: [
          `🔝 Peak active users: **${report.peak ? fmt(report.peak.active) : '—'}**${
            report.peak ? ` *(${shortDate(report.peak.date, report.intervals.stat === 'hour')})*` : ''
          }`,
          `📉 Average active users: **${fmt1(report.averageActive)}** per ${peakUnit}`,
          report.busiest
            ? `🔥 Busiest ${peakUnit}: **${shortDate(report.busiest.date, report.intervals.stat === 'hour')}** *(${fmt(report.busiest.engagements)} engagements)*`
            : null,
          `🧭 Trend: ${trendLabel(report.trend)}`,
        ]
          .filter(Boolean)
          .join('\n'),
        inline: true,
      },
      {
        name: '🔥  Engagement Metrics',
        value: [
          `💬 Avg messages / active user: **${fmt1(report.avgMessagesPerActive)}**`,
          `😀 Avg reactions / active user: **${fmt1(report.avgReactionsPerActive)}**`,
          `🎯 Total engagements: **${fmt(report.engagements)}**`,
          '*messages + reactions + voice sessions*',
        ].join('\n'),
        inline: true,
      }
    );

  const { labels, counts, percents } = report.breakdown;
  const icons = ['💬', '😀', '🔊', '📥', '📤'];
  const breakdownLines = labels.map(
    (label, i) => `${icons[i]} \`${bar(percents[i])}\` **${percents[i].toFixed(1)}%** ${label} *(${fmt(counts[i])})*`
  );

  const e2 = new EmbedBuilder()
    .setColor(COLOR)
    .addFields(
      {
        name: '🧩  Activity Breakdown',
        value: `${breakdownLines.join('\n')}\n*Share of all five event types above — totals 100%.*`,
      },
      { name: '🛰️  Server Status', value: guildStatusText(guild) }
    )
    .setFooter({ text: `${FOOTER} • Last updated` })
    .setTimestamp();

  if (report.isEmpty && !report.coverage.noData) {
    e2.setDescription('📭 No activity was recorded in this period.');
  }
  if (hasChart) e2.setImage(`attachment://${CHART_FILE}`);
  if (guild.iconURL?.()) e1.setThumbnail(guild.iconURL());

  return [e1, e2];
}

function memberReportEmbeds(report, guild, hasChart) {
  const { user } = report;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`👤  Member Analytics — ${user.username}`.slice(0, 256))
    .setDescription(`**User:** <@${user.id}> · \`${user.id}\`\n**Server:** ${guild.name}\n${periodBlock(report)}`)
    .addFields(
      {
        name: '📬  Activity',
        value: [
          `💬 Messages sent: **${fmt(report.messages)}**`,
          `😀 Reactions given: **${fmt(report.reactions)}**`,
          `🔊 Voice: **${fmt(report.voiceSessions)}** sessions · **${formatDuration(report.voiceSeconds)}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '🔥  Engagement',
        value: [
          `🎯 Total engagements: **${fmt(report.engagements)}**`,
          '*messages + reactions + voice sessions*',
          `📆 Avg daily activity: **${fmt1(report.avgDailyEngagements)}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📈  Patterns',
        value: [
          `🏆 Most active day: **${report.mostActiveDay ? `${shortDate(report.mostActiveDay.date, false)} · ${fmt(report.mostActiveDay.engagements)} engagements` : '—'}**`,
          `🧭 Trend: ${trendLabel(report.trend)}`,
        ].join('\n'),
      }
    )
    .setFooter({ text: `${FOOTER} • Last updated` })
    .setTimestamp();

  if (report.isEmpty && !report.coverage.noData) {
    embed.addFields({ name: '\u200b', value: '📭 No activity from this member was recorded in this period.' });
  }
  if (user.avatarURL) embed.setThumbnail(user.avatarURL);
  if (hasChart) embed.setImage(`attachment://${CHART_FILE}`);
  return [embed];
}

function trunc(s, n) {
  const clean = String(s).replace(/[`\n\r]/g, '');
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

function leaderboardEmbed({ guild, window, coverage, rows, weights }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`🏆  Activity Leaderboard — ${guild.name}`.slice(0, 256))
    .setFooter({ text: `${FOOTER} • Last updated` })
    .setTimestamp();

  const header = periodBlock({ window, coverage });
  if (!rows.length) {
    embed.setDescription(`${header}\n\n📭 No member activity recorded in this period.`);
    return embed;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const table = [
    ' #  Member           Msgs  React  Voice       Score',
    '─────────────────────────────────────────────────────',
    ...rows.map((r, i) => {
      const rank = String(i + 1).padStart(2, ' ');
      return `${rank}  ${trunc(r.name, 14).padEnd(14)} ${fmt(r.messages).padStart(5)}  ${fmt(r.reactions).padStart(5)}  ${formatDuration(r.voiceSeconds).padEnd(9)} ${fmt1(r.score).padStart(8)}`;
    }),
  ].join('\n');

  const podium = rows
    .slice(0, 3)
    .map((r, i) => `${medals[i]} <@${r.userId}> — **${fmt1(r.score)}** pts`)
    .join('\n');

  embed.setDescription(`${header}\n\n${podium}\n\`\`\`\n${table}\n\`\`\``);
  embed.addFields({
    name: '🧮  How the score works',
    value: `\`score = messages × ${weights.message} + reactions × ${weights.reaction} + voice minutes × ${weights.voiceMinute}\`\nBots are excluded. Members who left the server aren't listed.`,
  });
  return embed;
}

function infoEmbed(title, description, color = COLOR) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: FOOTER });
}

function errorEmbed(description) {
  return infoEmbed('❌  Analytics', description, COLOR_FAIL);
}

function helpEmbed() {
  return infoEmbed(
    '📖  Analytics — Commands',
    [
      '**Reports** *(Administrators only)*',
      '`/analytics report amount unit` — server-wide report + chart. Units: hours, days, weeks, months, years.',
      '> e.g. `6 hours` · `1 day` · `14 days` · `2 weeks` · `4 months` · `1 year`',
      '`/analytics report amount unit member:@user` — that member\u2019s report (paste a mention or a user ID).',
      '`/analytics leaderboard [amount] [unit]` — most active members (default 30 days).',
      '`/analytics backfill amount unit` — recover past messages, joins and approximate reactions.',
      '',
      '**Setup**',
      '`/analytics status` · `/analytics enable` · `/analytics disable`',
      '',
      '**Definitions**',
      '• **Active user** — a non-bot member with ≥1 message, reaction or voice session in the period.',
      '• **Engagements** — messages + reactions added + voice sessions started (each event counted once).',
      '• **Activity score** — messages × 1 + reactions × 0.5 + voice minutes × 0.2.',
      '• Months/years are calendar periods in UTC. Live data exists from when tracking was enabled; backfill can recover earlier messages.',
    ].join('\n')
  );
}

function statusEmbed({ guild, state, maxDays, flushSeconds }) {
  const lines = [];
  if (!state) {
    lines.push('📴 **Not enabled** for this server.', 'Run `/analytics enable` to start collecting activity.');
  } else {
    lines.push(state.enabled ? '🟢 **Tracking is ON**' : '⏸️ **Tracking is paused**');
    lines.push(`📅 Live tracking since <t:${unix(state.trackingStartedAt)}:f>`);
    if (state.backfilledFrom) lines.push(`📚 History backfilled from <t:${unix(state.backfilledFrom)}:f> (messages, joins, approximate reactions)`);
    if (state.pausedFrom) {
      lines.push(`⏸️ Last pause: <t:${unix(state.pausedFrom)}:f> → ${state.pausedTo ? `<t:${unix(state.pausedTo)}:f>` : 'still paused'}`);
    }
  }
  lines.push('', `Max reporting period: **${maxDays} days** · Data is written every **${flushSeconds}s**.`);
  lines.push('', 'No message content is stored — only counts and timestamps.');
  return infoEmbed(`⚙️  Analytics — ${guild.name}`.slice(0, 256), lines.join('\n'));
}

module.exports = {
  CHART_FILE,
  COLOR,
  COLOR_WARN,
  serverReportEmbeds,
  memberReportEmbeds,
  leaderboardEmbed,
  infoEmbed,
  errorEmbed,
  helpEmbed,
  statusEmbed,
  DAY_MS,
};
