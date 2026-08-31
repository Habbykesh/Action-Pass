const { SlashCommandBuilder } = require('discord.js');
const { prisma } = require('../database/connect');
const { isBotOwner } = require('../utils/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('partner-access')
    .setDescription('[Bot owner only] Manage which servers can create their own campaigns.')
    .addSubcommand((sub) =>
      sub
        .setName('global')
        .setDescription('Enable or disable campaign access for ALL servers with the bot installed.')
        .addBooleanOption((opt) =>
          opt.setName('enabled').setDescription('Turn global partner access on or off').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('server')
        .setDescription('Grant or revoke campaign access for one specific server.')
        .addStringOption((opt) =>
          opt.setName('guild-id').setDescription('The Discord server (guild) ID').setRequired(true)
        )
        .addBooleanOption((opt) =>
          opt.setName('enabled').setDescription('Grant or revoke access for that server').setRequired(true)
        )
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('View current access control settings.')),

  async execute(interaction) {
    if (!isBotOwner(interaction.user.id)) {
      await interaction.reply({
        content: '🔒 This command is restricted to the bot owner.',
        ephemeral: true,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'global') {
      const enabled = interaction.options.getBoolean('enabled');
      await prisma.botSettings.upsert({
        where: { id: 1 },
        update: { globalPartnerAccess: enabled },
        create: { id: 1, globalPartnerAccess: enabled },
      });
      await interaction.reply({
        content: `🌐 Global Partner Access is now **${enabled ? 'ENABLED' : 'DISABLED'}**.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'server') {
      const guildId = interaction.options.getString('guild-id');
      const enabled = interaction.options.getBoolean('enabled');

      await prisma.guildConfig.upsert({
        where: { guildId },
        update: { campaignAccess: enabled },
        create: { guildId, campaignAccess: enabled },
      });

      await interaction.reply({
        content: `Access for server \`${guildId}\` is now **${enabled ? 'ENABLED' : 'DISABLED'}**.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'status') {
      const settings = await prisma.botSettings.findUnique({ where: { id: 1 } });
      const guildConfigs = await prisma.guildConfig.findMany({
        where: { campaignAccess: true },
      });

      const lines = guildConfigs.length
        ? guildConfigs.map((g) => `• ${g.guildName || g.guildId} (\`${g.guildId}\`) — Enabled`).join('\n')
        : '_No individual servers have been granted access._';

      await interaction.reply({
        content:
          `🌐 Global Partner Access: **${settings?.globalPartnerAccess ? 'ENABLED' : 'DISABLED'}**\n\n` +
          `**Per-server overrides:**\n${lines}`,
        ephemeral: true,
      });
    }
  },
};
