const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { isActionModelGuild, hasManageGuild } = require('../utils/permissions');
const { getSettings } = require('../services/actionModelSettingsService');
const { getStats } = require('../services/accessCodeService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('codes')
    .setDescription('[Action Model only] View Alpha/campaign code statistics.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isActionModelGuild(interaction.guildId)) {
      await interaction.reply({ content: '🔒 This command is only available in the Action Model server.', ephemeral: true });
      return;
    }
    if (!hasManageGuild(interaction)) {
      await interaction.reply({ content: '🔒 You need the Manage Server permission to use this.', ephemeral: true });
      return;
    }

    const settings = await getSettings();
    const { total, used, unused } = await getStats(interaction.guildId);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`Alpha / Campaign Codes — ${settings.campaignButtonLabel}`)
      .addFields(
        { name: 'Total Generated', value: String(total), inline: true },
        { name: 'Unused', value: String(unused), inline: true },
        { name: 'Used', value: String(used), inline: true }
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
