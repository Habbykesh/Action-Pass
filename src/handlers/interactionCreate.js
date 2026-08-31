const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { prisma } = require('../database/connect');
const { getDraft, touchDraft, clearDraft } = require('../utils/campaignWizard');
const {
  wizardEmbed,
  wizardRows,
  verificationEmbed,
  eligibleEmbed,
  successEmbed,
  missingServersEmbed,
  campaignNotActiveEmbed,
} = require('../utils/embeds');
const { createOrResolveCampaignRole } = require('../services/roleService');
const { handleVerificationAttempt } = require('../services/verificationService');
const { logToCampaignGuilds } = require('../services/logService');

async function handleSlashCommand(interaction) {
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[command:${interaction.commandName}]`, err);
    const payload = { content: '⚠️ Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
}

async function handleAutocomplete(interaction) {
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command?.autocomplete) return;
  try {
    await command.autocomplete(interaction);
  } catch (err) {
    console.error(`[autocomplete:${interaction.commandName}]`, err);
  }
}

async function refreshWizardMessage(interaction, draft) {
  await interaction.update({ embeds: [wizardEmbed(draft)], components: wizardRows(draft) });
}

async function handleWizardButton(interaction) {
  const draft = touchDraft(interaction.user.id, interaction.guildId);
  if (!draft) {
    await interaction.reply({
      content: 'This campaign draft has expired. Run `/campaign create` again to start over.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === 'wizard_add_server') {
    const modal = new ModalBuilder()
      .setCustomId('modal_add_server')
      .setTitle('Add Required Server')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('server_name').setLabel('Server name').setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('server_guild_id')
            .setLabel('Server (guild) ID')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('server_invite')
            .setLabel('Invite link')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
    return;
  }

  if (interaction.customId === 'wizard_set_role') {
    if (draft.requiredServers.length < 2) {
      await interaction.reply({ content: 'Add at least 2 servers before choosing where the role lives.', ephemeral: true });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId('wizard_role_server_select')
      .setPlaceholder('Which server should hold the verification role?')
      .addOptions(draft.requiredServers.map((s) => ({ label: s.name, value: s.guildId })));

    await interaction.update({
      embeds: [wizardEmbed(draft)],
      components: [new ActionRowBuilder().addComponents(select)],
    });
    return;
  }

  if (interaction.customId === 'wizard_set_dates') {
    const modal = new ModalBuilder()
      .setCustomId('modal_set_dates')
      .setTitle('Verification Period')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('start_at')
            .setLabel('Start (UTC, e.g. 2026-09-01 12:00)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('deadline_at')
            .setLabel('Deadline (UTC, e.g. 2026-09-30 23:59)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
    return;
  }

  if (interaction.customId === 'wizard_role_auto' || interaction.customId === 'wizard_role_existing') {
    if (interaction.customId === 'wizard_role_existing') {
      const modal = new ModalBuilder()
        .setCustomId('modal_role_existing')
        .setTitle('Use Existing Role')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('role_id')
              .setLabel('Existing role ID (in the role server)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      await interaction.showModal(modal);
      return;
    }
    draft.existingRoleId = null;
    await refreshWizardMessage(interaction, draft);
    return;
  }

  if (interaction.customId === 'wizard_cancel') {
    clearDraft(interaction.user.id, interaction.guildId);
    await interaction.update({ content: 'Campaign creation cancelled.', embeds: [], components: [] });
    return;
  }

  if (interaction.customId === 'wizard_finish') {
    await finishWizard(interaction, draft);
  }
}

async function finishWizard(interaction, draft) {
  await interaction.deferUpdate();

  try {
    const { roleId, roleAutoCreated } = await createOrResolveCampaignRole(interaction.client, {
      roleServerId: draft.roleServerId,
      roleName: draft.name,
      existingRoleId: draft.existingRoleId,
    });

    const campaign = await prisma.campaign.create({
      data: {
        name: draft.name,
        ownerGuildId: draft.ownerGuildId,
        createdByUserId: draft.createdByUserId,
        roleServerId: draft.roleServerId,
        roleId,
        roleName: draft.name,
        roleAutoCreated,
        startAt: draft.startAt,
        deadlineAt: draft.deadlineAt,
        requiredServers: {
          create: draft.requiredServers.map((s) => ({
            guildId: s.guildId,
            name: s.name,
            inviteLink: s.inviteLink,
          })),
        },
      },
      include: { requiredServers: true },
    });

    clearDraft(interaction.user.id, interaction.guildId);

    await interaction.editReply({
      content:
        `✅ **${campaign.name}** created!\n\n` +
        `Use \`/campaign repost\` in each participating server to post the verification embed.`,
      embeds: [],
      components: [],
    });

    await logToCampaignGuilds(
      interaction.client,
      campaign,
      '📋 Campaign Created',
      `${campaign.name}\nCreated by <@${campaign.createdByUserId}>`
    );
  } catch (err) {
    console.error('[wizard_finish]', err);
    await interaction.editReply({
      content: `⚠️ Couldn't create the campaign: ${err.message}`,
      embeds: [],
      components: [],
    });
  }
}

async function handleSelectMenu(interaction) {
  if (interaction.customId !== 'wizard_role_server_select') return;

  const draft = touchDraft(interaction.user.id, interaction.guildId);
  if (!draft) {
    await interaction.reply({ content: 'This campaign draft has expired. Run `/campaign create` again.', ephemeral: true });
    return;
  }

  draft.roleServerId = interaction.values[0];

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wizard_role_auto').setLabel('Auto-create role').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('wizard_role_existing').setLabel('Use existing role').setStyle(ButtonStyle.Secondary)
  );

  await interaction.update({ embeds: [wizardEmbed(draft)], components: [row] });
}

async function handleModalSubmit(interaction) {
  const draft = touchDraft(interaction.user.id, interaction.guildId);
  if (!draft) {
    await interaction.reply({ content: 'This campaign draft has expired. Run `/campaign create` again.', ephemeral: true });
    return;
  }

  if (interaction.customId === 'modal_add_server') {
    draft.requiredServers.push({
      name: interaction.fields.getTextInputValue('server_name').trim(),
      guildId: interaction.fields.getTextInputValue('server_guild_id').trim(),
      inviteLink: interaction.fields.getTextInputValue('server_invite').trim(),
    });
    await interaction.update({ embeds: [wizardEmbed(draft)], components: wizardRows(draft) });
    return;
  }

  if (interaction.customId === 'modal_set_dates') {
    const startRaw = interaction.fields.getTextInputValue('start_at').trim();
    const deadlineRaw = interaction.fields.getTextInputValue('deadline_at').trim();
    const startAt = new Date(`${startRaw.replace(' ', 'T')}Z`);
    const deadlineAt = new Date(`${deadlineRaw.replace(' ', 'T')}Z`);

    if (Number.isNaN(startAt.getTime()) || Number.isNaN(deadlineAt.getTime()) || deadlineAt <= startAt) {
      await interaction.reply({
        content: 'Couldn\u2019t parse those dates, or the deadline isn\u2019t after the start. Use the format `YYYY-MM-DD HH:mm` and try again.',
        ephemeral: true,
      });
      return;
    }

    draft.startAt = startAt;
    draft.deadlineAt = deadlineAt;
    await interaction.update({ embeds: [wizardEmbed(draft)], components: wizardRows(draft) });
    return;
  }

  if (interaction.customId === 'modal_role_existing') {
    draft.existingRoleId = interaction.fields.getTextInputValue('role_id').trim();
    await interaction.update({ embeds: [wizardEmbed(draft)], components: wizardRows(draft) });
  }
}

async function handleVerifyButton(interaction) {
  const campaignId = interaction.customId.replace('verify_', '');
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { requiredServers: true },
  });

  if (!campaign) {
    await interaction.reply({ content: 'This campaign no longer exists.', ephemeral: true });
    return;
  }

  const now = new Date();
  if (campaign.status !== 'active' || now < campaign.startAt || now > campaign.deadlineAt) {
    await interaction.reply({ embeds: [campaignNotActiveEmbed(campaign)], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const { alreadyVerified, allPresent, statusMap } = await handleVerificationAttempt(
    interaction.client,
    campaign,
    interaction.user.id,
    interaction.user.username
  );

  if (alreadyVerified) {
    await interaction.editReply({ embeds: [eligibleEmbed()] });
  } else if (allPresent) {
    await interaction.editReply({ embeds: [successEmbed(campaign)] });
  } else {
    await interaction.editReply({ embeds: [missingServersEmbed(campaign, statusMap)] });
  }
}

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('verify_')) {
        await handleVerifyButton(interaction);
        return;
      }
      if (interaction.customId.startsWith('wizard_')) {
        await handleWizardButton(interaction);
        return;
      }
      return;
    }
    if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
  },
};
