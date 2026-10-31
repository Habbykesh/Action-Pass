const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { isServerAdmin, isBotOwner } = require('../utils/permissions');
const { collector } = require('../services/analytics/collector');
const svc = require('../services/analytics/commandService');
const embeds = require('../utils/analyticsEmbeds');

const COOLDOWN_MS = 3000;
const cooldowns = new Map();

const UNITS = [
  { name: 'hours', value: 'hour' },
  { name: 'days', value: 'day' },
  { name: 'weeks', value: 'week' },
  { name: 'months', value: 'month' },
  { name: 'years', value: 'year' },
];

const amountOpt = (required, desc) => (o) => o.setName('amount').setDescription(desc).setMinValue(1).setMaxValue(100000).setRequired(required);
const unitOpt = (required) => (o) => o.setName('unit').setDescription('hours, days, weeks, months or years').addChoices(...UNITS).setRequired(required);
const privateOpt = (o) => o.setName('private').setDescription('Only show the result to you').setRequired(false);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('analytics')
    .setDescription('[Admin] Server & member activity analytics.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('report')
        .setDescription('Activity report for any period, server-wide or for one member.')
        .addIntegerOption(amountOpt(true, 'How many (e.g. 14)'))
        .addStringOption(unitOpt(true))
        .addUserOption((o) => o.setName('member').setDescription('Member (mention or user ID) — omit for the whole server').setRequired(false))
        .addBooleanOption(privateOpt)
    )
    .addSubcommand((s) =>
      s
        .setName('leaderboard')
        .setDescription('Most active members (default: last 30 days).')
        .addIntegerOption(amountOpt(false, 'How many (default 30)'))
        .addStringOption(unitOpt(false))
        .addBooleanOption(privateOpt)
    )
    .addSubcommand((s) =>
      s
        .setName('backfill')
        .setDescription('Recover past messages, joins and approximate reactions from Discord history.')
        .addIntegerOption(amountOpt(true, 'How many (e.g. 30)'))
        .addStringOption(unitOpt(true))
    )
    .addSubcommand((s) => s.setName('status').setDescription('Tracking status for this server.'))
    .addSubcommand((s) => s.setName('enable').setDescription('Start tracking activity in this server.'))
    .addSubcommand((s) => s.setName('disable').setDescription('Pause tracking (existing data is kept).'))
    .addSubcommand((s) => s.setName('help').setDescription('Commands and metric definitions.')),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: '🔒 Analytics only works inside a server.', ephemeral: true });
      return;
    }
    // Same rule as the rest of Action Pass: Administrator (or a bot owner).
    if (!isServerAdmin(interaction) && !isBotOwner(interaction.user.id)) {
      await interaction.reply({ content: '🔒 Analytics commands are restricted to server administrators.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const heavy = sub === 'report' || sub === 'leaderboard' || sub === 'backfill';
    if (heavy) {
      const now = Date.now();
      if (now - (cooldowns.get(interaction.user.id) || 0) < COOLDOWN_MS) {
        await interaction.reply({ content: '⏳ One moment — please wait a few seconds between analytics commands.', ephemeral: true });
        return;
      }
      cooldowns.set(interaction.user.id, now);
      if (cooldowns.size > 500) for (const [k, t] of cooldowns) if (now - t > 60_000) cooldowns.delete(k);
    }

    const isPrivate = interaction.options.getBoolean('private') ?? ['status', 'enable', 'disable', 'help'].includes(sub);
    await interaction.deferReply({ ephemeral: isPrivate });
    const ctx = svc.makeCtx(interaction);

    try {
      if (sub === 'report') {
        await svc.runReport(ctx, collector, {
          amount: interaction.options.getInteger('amount'),
          unit: interaction.options.getString('unit'),
          user: interaction.options.getUser('member'),
        });
      } else if (sub === 'leaderboard') {
        await svc.runLeaderboard(ctx, collector, {
          amount: interaction.options.getInteger('amount'),
          unit: interaction.options.getString('unit'),
        });
      } else if (sub === 'backfill') {
        await svc.runBackfillCommand(ctx, collector, {
          amount: interaction.options.getInteger('amount'),
          unit: interaction.options.getString('unit'),
        });
      } else {
        await svc.runAdmin(ctx, collector, sub);
      }
    } catch (err) {
      console.error('[analytics] command failed:', err);
      await svc.safeReply(ctx, { embeds: [embeds.errorEmbed('Something went wrong while building that report. Please try again in a moment.')] });
    }
  },
};
