const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { prisma } = require('../database/connect');
const { isActionModelGuild } = require('../utils/permissions');
const { getSettings } = require('../services/actionModelSettingsService');
const { summaryEmbed, menuRows } = require('../utils/actionModelSetupUI');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure this server\u2019s bot settings.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('log-channel')
        .setDescription('Choose the single channel all bot activity is logged to.')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('The channel to send logs to')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('[Action Model only] Configure the Alpha Gate + Verification Gate panel.')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'log-channel') {
      const channel = interaction.options.getChannel('channel');

      await prisma.guildConfig.upsert({
        where: { guildId: interaction.guildId },
        update: { logChannelId: channel.id, guildName: interaction.guild.name },
        create: {
          guildId: interaction.guildId,
          guildName: interaction.guild.name,
          logChannelId: channel.id,
        },
      });

      await interaction.reply({
        content: `⚙️ Bot Setup\n\nLog channel set to ${channel}. All relevant activity will be sent there going forward.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'panel') {
      if (!isActionModelGuild(interaction.guildId)) {
        await interaction.reply({
          content: '🔒 The Alpha Gate + Verification Gate panel is only available in the Action Model server.',
          ephemeral: true,
        });
        return;
      }

      const settings = await getSettings();
      await interaction.reply({
        embeds: [summaryEmbed(settings)],
        components: menuRows(settings),
        ephemeral: true,
      });
    }
  },
};
