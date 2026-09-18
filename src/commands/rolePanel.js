const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { prisma } = require('../database/connect');
const { isActionModelGuild, hasManageGuild } = require('../utils/permissions');
const { startDraft } = require('../utils/rolePanelWizard');
const { rolePanelWizardEmbed, rolePanelWizardRows } = require('../utils/rolePanelEmbeds');
const { postOrUpdatePanel, findMissingRoles } = require('../services/rolePanelService');
const { logToGuild } = require('../services/logService');

async function panelChoices(interaction) {
  return prisma.rolePanel.findMany({ where: { guildId: interaction.guildId }, take: 25, orderBy: { createdAt: 'desc' } });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role-panel')
    .setDescription('[Action Model only] Manage button-based role selection panels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Start creating a new role panel.')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Internal panel name/ID, e.g. "regional-roles"').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Edit an existing role panel.')
        .addStringOption((opt) => opt.setName('name').setDescription('Internal panel name').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Delete a role panel.')
        .addStringOption((opt) => opt.setName('name').setDescription('Internal panel name').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('repost')
        .setDescription('Post (or repost) a role panel in a channel.')
        .addStringOption((opt) => opt.setName('name').setDescription('Internal panel name').setRequired(true).setAutocomplete(true))
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('Channel to post in (defaults to this channel)').addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List all role panels on this server.')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const panels = await panelChoices(interaction);
    const filtered = panels
      .filter((p) => p.internalName.toLowerCase().includes(String(focused).toLowerCase()))
      .slice(0, 25);
    await interaction.respond(filtered.map((p) => ({ name: `${p.internalName} — ${p.title}`, value: p.internalName })));
  },

  async execute(interaction) {
    if (!isActionModelGuild(interaction.guildId)) {
      await interaction.reply({ content: '🔒 Role Panels are only available in the Action Model server.', ephemeral: true });
      return;
    }
    if (!hasManageGuild(interaction)) {
      await interaction.reply({ content: '🔒 You need the Manage Server permission to use this.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      const name = interaction.options.getString('name').trim().toLowerCase();
      const exists = await prisma.rolePanel.findUnique({
        where: { guildId_internalName: { guildId: interaction.guildId, internalName: name } },
      });
      if (exists) {
        await interaction.reply({
          content: `A panel named \`${name}\` already exists. Use \`/role-panel edit name:${name}\` instead, or pick a different name.`,
          ephemeral: true,
        });
        return;
      }

      const draft = startDraft(interaction.user.id, interaction.guildId, name);
      await interaction.reply({ embeds: [rolePanelWizardEmbed(draft)], components: rolePanelWizardRows(draft), ephemeral: true });
      return;
    }

    if (sub === 'edit') {
      const name = interaction.options.getString('name').trim().toLowerCase();
      const panel = await prisma.rolePanel.findUnique({
        where: { guildId_internalName: { guildId: interaction.guildId, internalName: name } },
        include: { buttons: true },
      });
      if (!panel) {
        await interaction.reply({ content: `No panel named \`${name}\`. Use \`/role-panel list\` to see valid names.`, ephemeral: true });
        return;
      }

      const missing = await findMissingRoles(interaction.guild, panel);
      const draft = startDraft(interaction.user.id, interaction.guildId, name, panel);
      let content;
      if (missing.length) {
        content = `⚠️ ${missing.length} button(s) point to a role that no longer exists: ${missing.map((b) => b.label).join(', ')}. Remove and re-add them below to fix.`;
      }
      await interaction.reply({ content, embeds: [rolePanelWizardEmbed(draft)], components: rolePanelWizardRows(draft), ephemeral: true });
      return;
    }

    if (sub === 'delete') {
      const name = interaction.options.getString('name').trim().toLowerCase();
      const panel = await prisma.rolePanel.findUnique({
        where: { guildId_internalName: { guildId: interaction.guildId, internalName: name } },
      });
      if (!panel) {
        await interaction.reply({ content: `No panel named \`${name}\`.`, ephemeral: true });
        return;
      }

      if (panel.channelId && panel.messageId) {
        const channel = interaction.guild.channels.cache.get(panel.channelId);
        const message = channel?.isTextBased() ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
        if (message) await message.delete().catch(() => {});
      }

      await prisma.rolePanel.delete({ where: { id: panel.id } });

      await interaction.reply({ content: `🗑️ Deleted role panel \`${name}\`.`, ephemeral: true });
      await logToGuild(interaction.client, interaction.guildId, '🗑️ Role Panel Deleted', `Panel: ${panel.title}\nDeleted by <@${interaction.user.id}>`);
      return;
    }

    if (sub === 'repost') {
      const name = interaction.options.getString('name').trim().toLowerCase();
      const panel = await prisma.rolePanel.findUnique({
        where: { guildId_internalName: { guildId: interaction.guildId, internalName: name } },
        include: { buttons: true },
      });
      if (!panel) {
        await interaction.reply({ content: `No panel named \`${name}\`.`, ephemeral: true });
        return;
      }
      if (!panel.buttons.length) {
        await interaction.reply({ content: 'This panel has no buttons yet — add at least one with `/role-panel edit` first.', ephemeral: true });
        return;
      }

      const missing = await findMissingRoles(interaction.guild, panel);
      if (missing.length) {
        await interaction.reply({
          content: `⚠️ Can\u2019t post — ${missing.length} button(s) point to a deleted role: ${missing.map((b) => b.label).join(', ')}. Fix them with \`/role-panel edit\` first.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const { updated } = await postOrUpdatePanel(interaction.client, panel, channel);

      await interaction.editReply({ content: updated ? `Updated the existing panel message in ${channel}.` : `Posted in ${channel}.` });
      await logToGuild(
        interaction.client,
        interaction.guildId,
        updated ? '🎛️ Role Panel Updated' : '🎛️ Role Panel Posted',
        `Panel: ${panel.title}\n${updated ? 'Updated' : 'Posted'} by <@${interaction.user.id}>`
      );
      return;
    }

    if (sub === 'list') {
      const panels = await panelChoices(interaction);
      if (!panels.length) {
        await interaction.reply({ content: 'No role panels created yet. Use `/role-panel create` to make one.', ephemeral: true });
        return;
      }
      const lines = await Promise.all(
        panels.map(async (p) => {
          const withButtons = await prisma.rolePanel.findUnique({ where: { id: p.id }, include: { buttons: true } });
          const missing = await findMissingRoles(interaction.guild, withButtons);
          const status = p.messageId ? 'posted' : 'not posted yet';
          const warn = missing.length ? ` ⚠️ ${missing.length} broken button(s)` : '';
          return `• **${p.internalName}** — ${p.title} (${withButtons.buttons.length} buttons, ${status})${warn}`;
        })
      );
      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
    }
  },
};
