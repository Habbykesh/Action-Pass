const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  AttachmentBuilder,
} = require('discord.js');
const { prisma } = require('../database/connect');
const { hasCampaignAccess } = require('../utils/permissions');
const { startDraft } = require('../utils/campaignWizard');
const {
  wizardEmbed,
  wizardRows,
  accessDeniedEmbed,
  verificationEmbed,
  logEmbed,
} = require('../utils/embeds');
const { recheckCampaign } = require('../services/verificationService');
const { exportToCsv, exportToExcel, exportToPdf } = require('../services/exportService');
const { logToCampaignGuilds } = require('../services/logService');

// A campaign should be manageable from ANY server that's actually part
// of it — the guild that created it, the guild holding the role, or any
// of the required servers — not just the exact guild it was created
// from. Otherwise an admin who hops into a partner server to repost the
// embed there finds nothing.
function campaignVisibilityWhere(guildId) {
  return {
    OR: [
      { ownerGuildId: guildId },
      { roleServerId: guildId },
      { requiredServers: { some: { guildId } } },
    ],
  };
}

async function ownedCampaignChoices(interaction) {
  const campaigns = await prisma.campaign.findMany({
    where: campaignVisibilityWhere(interaction.guildId),
    include: { requiredServers: true },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  return campaigns;
}

async function resolveCampaignOption(interaction) {
  const name = interaction.options.getString('campaign');
  const campaign = await prisma.campaign.findFirst({
    where: { name, ...campaignVisibilityWhere(interaction.guildId) },
    include: { requiredServers: true },
  });
  return campaign;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('campaign')
    .setDescription('Create and manage ActionFi partnership verification campaigns.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Start creating a new partnership campaign.')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Campaign name, e.g. "ActionFi x Kora"').setRequired(true)
        )
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List all campaigns for this server.'))
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('View full details of a campaign.')
        .addStringOption((opt) => opt.setName('campaign').setDescription('Campaign name').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('stats')
        .setDescription('View statistics for a campaign.')
        .addStringOption((opt) => opt.setName('campaign').setDescription('Campaign name').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('members')
        .setDescription('List tracked members for a campaign.')
        .addStringOption((opt) => opt.setName('campaign').setDescription('Campaign name').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('export')
        .setDescription('Export a campaign\u2019s eligible member list.')
        .addStringOption((opt) => opt.setName('campaign').setDescription('Campaign name').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) =>
          opt
            .setName('format')
            .setDescription('Export format')
            .setRequired(true)
            .addChoices({ name: 'CSV', value: 'csv' }, { name: 'Excel', value: 'excel' }, { name: 'PDF', value: 'pdf' })
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('recheck')
        .setDescription('Re-verify eligibility for every tracked member of a campaign.')
        .addStringOption((opt) => opt.setName('campaign').setDescription('Campaign name').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('repost')
        .setDescription('Post (or repost) the verification embed for a campaign in this channel.')
        .addStringOption((opt) => opt.setName('campaign').setDescription('Campaign name').setRequired(true).setAutocomplete(true))
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('Channel to post in (defaults to this channel)').addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('end')
        .setDescription('Stop verification for a campaign.')
        .addStringOption((opt) => opt.setName('campaign').setDescription('Campaign name').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('archive')
        .setDescription('Archive an ended campaign for historical record-keeping.')
        .addStringOption((opt) => opt.setName('campaign').setDescription('Campaign name').setRequired(true).setAutocomplete(true))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const campaigns = await ownedCampaignChoices(interaction);
    const filtered = campaigns
      .filter((c) => c.name.toLowerCase().includes(String(focused).toLowerCase()))
      .slice(0, 25);
    await interaction.respond(filtered.map((c) => ({ name: `${c.name} (${c.status})`, value: c.name })));
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      const allowed = await hasCampaignAccess(interaction.guildId);
      if (!allowed) {
        await interaction.reply({ embeds: [accessDeniedEmbed()], ephemeral: true });
        return;
      }

      const name = interaction.options.getString('name');
      const draft = startDraft(interaction.user.id, interaction.guildId, name);

      await interaction.reply({
        embeds: [wizardEmbed(draft)],
        components: wizardRows(draft),
        ephemeral: true,
      });
      return;
    }

    if (sub === 'list') {
      const campaigns = await ownedCampaignChoices(interaction);
      if (!campaigns.length) {
        await interaction.reply({ content: 'No campaigns have been created for this server yet.', ephemeral: true });
        return;
      }
      const lines = campaigns.map((c) => `• **${c.name}** — ${c.status} (${c.requiredServers.length} servers)`);
      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      return;
    }

    const campaign = await resolveCampaignOption(interaction);
    if (!campaign) {
      await interaction.reply({ content: 'Campaign not found. Use `/campaign list` to see valid names.', ephemeral: true });
      return;
    }

    // end / archive / export / recheck are restricted to the server that
    // created the campaign — a partner server admin can view, check
    // stats, see members, and repost the embed, but can't end the
    // campaign, archive it, pull the eligibility export, or force a
    // recheck on ActionFi's behalf.
    const OWNER_GUILD_ONLY_SUBCOMMANDS = new Set(['end', 'archive', 'export', 'recheck']);
    if (OWNER_GUILD_ONLY_SUBCOMMANDS.has(sub) && campaign.ownerGuildId !== interaction.guildId) {
      await interaction.reply({
        content: `🔒 Only admins in the server that created **${campaign.name}** can do that.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'view') {
      const serverLines = campaign.requiredServers.map((s) => `• ${s.name} (\`${s.guildId}\`)`).join('\n');
      await interaction.reply({
        content:
          `📋 **${campaign.name}** — ${campaign.status}\n\n` +
          `**Required servers:**\n${serverLines}\n\n` +
          `**Role:** ${campaign.roleName} in \`${campaign.roleServerId}\`\n` +
          `**Verification period:** ${campaign.startAt.toUTCString()} → ${campaign.deadlineAt.toUTCString()}\n` +
          `**Verification attempts:** ${campaign.verificationActivityCount}`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'stats') {
      const [eligibleCount, totalAttempts, sourceCounts] = await Promise.all([
        prisma.campaignMember.count({ where: { campaignId: campaign.id, eligible: true } }),
        prisma.campaignMember.count({ where: { campaignId: campaign.id } }),
        prisma.campaignMember.groupBy({
          by: ['sourceGuildId'],
          where: { campaignId: campaign.id, eligible: true },
          _count: { _all: true },
        }),
      ]);

      const crossoverLines = campaign.requiredServers
        .map((server) => {
          const match = sourceCounts.find((row) => row.sourceGuildId === server.guildId);
          return `• From **${server.name}** → joined the rest: ${match?._count._all || 0}`;
        })
        .join('\n');

      await interaction.reply({
        content:
          `📊 **${campaign.name}** statistics\n\n` +
          `Verification Activity: ${campaign.verificationActivityCount}\n` +
          `Unique members who attempted: ${totalAttempts}\n` +
          `Currently Eligible: ${eligibleCount}\n\n` +
          `**🔀 Crossover by source** (which embed drove the verification):\n${crossoverLines}`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'members') {
      const members = await prisma.campaignMember.findMany({
        where: { campaignId: campaign.id },
        orderBy: { updatedAt: 'desc' },
        take: 25,
      });
      if (!members.length) {
        await interaction.reply({ content: 'No one has attempted verification for this campaign yet.', ephemeral: true });
        return;
      }
      const lines = members.map(
        (m) => `• <@${m.userId}> — ${m.eligible ? '✅ Eligible' : '❌ Not eligible'} (last checked ${m.lastCheckedAt?.toDateString() || 'never'})`
      );
      await interaction.reply({
        content: `Showing up to 25 most recently updated members for **${campaign.name}**:\n\n${lines.join('\n')}`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'export') {
      const format = interaction.options.getString('format');
      await interaction.deferReply({ ephemeral: true });

      const exporter = { csv: exportToCsv, excel: exportToExcel, pdf: exportToPdf }[format];
      const { filePath } = await exporter(campaign.id);

      const attachment = new AttachmentBuilder(filePath);
      await interaction.editReply({
        content: `📤 **${campaign.name}** — Eligible Members (${format.toUpperCase()})`,
        files: [attachment],
      });

      await logToCampaignGuilds(
        interaction.client,
        campaign,
        '📤 Export Generated',
        `${campaign.name}\nFormat: ${format.toUpperCase()}`
      );
      return;
    }

    if (sub === 'recheck') {
      await interaction.deferReply({ ephemeral: true });
      const { checked, becameIneligible } = await recheckCampaign(interaction.client, campaign);
      await interaction.editReply({
        content: `🔄 Rechecked ${checked} tracked member(s) for **${campaign.name}**. ${becameIneligible} lost eligibility.`,
      });
      return;
    }

    if (sub === 'repost') {
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const message = await channel.send(verificationEmbed(campaign, channel.guild.iconURL({ size: 256 })));

      await prisma.postedEmbed.create({
        data: {
          campaignId: campaign.id,
          guildId: interaction.guildId,
          channelId: channel.id,
          messageId: message.id,
        },
      });

      await interaction.reply({ content: `Verification embed posted in ${channel}.`, ephemeral: true });
      return;
    }

    if (sub === 'end') {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'ended', endedAt: new Date(), endedByUserId: interaction.user.id },
      });
      await interaction.reply({ content: `🔒 **${campaign.name}** has been ended. No new verifications will be accepted.`, ephemeral: true });
      await logToCampaignGuilds(
        interaction.client,
        campaign,
        '🔒 Campaign Ended',
        `${campaign.name}\nEnded by <@${interaction.user.id}>`
      );
      return;
    }

    if (sub === 'archive') {
      if (campaign.status === 'active') {
        await interaction.reply({ content: 'End the campaign before archiving it.', ephemeral: true });
        return;
      }
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'archived', archivedAt: new Date() },
      });
      await interaction.reply({ content: `📦 **${campaign.name}** has been archived.`, ephemeral: true });
    }
  },
};
