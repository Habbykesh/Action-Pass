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
  usernameRequiredEmbed,
} = require('../utils/embeds');
const { createOrResolveCampaignRole, assignGuildRole, memberHasRole } = require('../services/roleService');
const { handleVerificationAttempt } = require('../services/verificationService');
const { logToCampaignGuilds, logToGuild } = require('../services/logService');
const { isActionModelGuild } = require('../utils/permissions');
const { getSettings, updateSettings, postOrUpdatePanel } = require('../services/actionModelSettingsService');
const {
  generateChallenge,
  getActiveChallenge,
  clearChallenge,
  checkAnswer,
} = require('../services/challengeService');
const { redeemCode, releaseCode } = require('../services/accessCodeService');
const {
  alreadyVerifiedEmbed,
  challengePrompt,
  challengeComponents,
  verifiedSuccessEmbed,
  verificationNotConfiguredEmbed,
  codeModal,
  wordChallengeModal,
  codeSuccessEmbed,
  codeFailEmbed,
} = require('../utils/actionModelEmbeds');
const { summaryEmbed, menuRows, textFieldModal, roleSelectRow, TEXT_FIELD_META } = require('../utils/actionModelSetupUI');
const {
  getDraft: getRolePanelDraft,
  touchDraft: touchRolePanelDraft,
  clearDraft: clearRolePanelDraft,
} = require('../utils/rolePanelWizard');
const {
  VALID_STYLES,
  normalizeStyle,
  rolePanelWizardEmbed,
  rolePanelWizardRows,
  infoModal,
  addButtonModal,
  roleMissingEmbed,
  roleSelectionEmbed,
} = require('../utils/rolePanelEmbeds');
const {
  postOrUpdatePanel: postOrUpdateRolePanel,
  handleRolePanelClick,
} = require('../services/rolePanelService');

// Every command except these two is restricted to the Action Model
// server. Partner servers only ever need to (a) post the verification
// embed via /campaign repost, and (b) let their own members link a
// username, which is required before verifying — so both stay usable
// everywhere. Everything else (campaign management, /setup, Alpha Gate,
// Role Panels, /partner-access) only runs inside Action Model.
const PARTNER_ALLOWED_COMMANDS = new Set(['link-username']);

async function handleSlashCommand(interaction) {
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) return;

  if (!isActionModelGuild(interaction.guildId) && !PARTNER_ALLOWED_COMMANDS.has(interaction.commandName)) {
    const isCampaignRepost =
      interaction.commandName === 'campaign' && interaction.options.getSubcommand(false) === 'repost';
    if (!isCampaignRepost) {
      await interaction.reply({
        content:
          '🔒 This command is only available in the Action Model server. Partner servers can use `/campaign repost` here, and `/link-username` to link an account.',
        ephemeral: true,
      });
      return;
    }
  }

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

  const { alreadyVerified, needsUsernameLink, allPresent, statusMap } = await handleVerificationAttempt(
    interaction.client,
    campaign,
    interaction.user.id,
    interaction.user.username,
    interaction.guildId
  );

  if (needsUsernameLink) {
    await interaction.editReply({ embeds: [usernameRequiredEmbed()] });
  } else if (alreadyVerified) {
    await interaction.editReply({ embeds: [eligibleEmbed()] });
  } else if (allPresent) {
    await interaction.editReply({ embeds: [successEmbed(campaign)] });
  } else {
    await interaction.editReply({ embeds: [missingServersEmbed(campaign, statusMap)] });
  }
}

// ── Action Model: Visual Verification Gate ──────────────────────────

function amLogLine({ username, userId, roleId, extra = '' }) {
  const time = new Date().toUTCString();
  return `Username: ${username}\nUser ID: ${userId}\nRole: <@&${roleId}>${extra}\nTime: ${time}`;
}

async function handleAmVerifyStart(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const settings = await getSettings();
  if (!settings.verificationRoleId) {
    await interaction.reply({ embeds: [verificationNotConfiguredEmbed()], ephemeral: true });
    return;
  }

  const already = await memberHasRole(interaction.client, interaction.guildId, interaction.user.id, settings.verificationRoleId);
  if (already) {
    await interaction.reply({ embeds: [alreadyVerifiedEmbed()], ephemeral: true });
    return;
  }

  const challenge = generateChallenge(interaction.user.id, interaction.guildId);
  await interaction.reply({
    embeds: [challengePrompt(challenge)],
    components: challengeComponents(challenge),
    ephemeral: true,
  });
}

async function finishVerification(interaction, settings) {
  clearChallenge(interaction.user.id, interaction.guildId);
  try {
    await assignGuildRole(interaction.client, interaction.guildId, interaction.user.id, settings.verificationRoleId, 'Passed visual verification');
  } catch (err) {
    console.error('[amverify] role assignment failed:', err.message);
    await interaction.update({
      content: '⚠️ You passed verification, but the role couldn’t be assigned (a permissions or role-hierarchy issue). Please contact an admin.',
      embeds: [],
      components: [],
      files: [],
    });
    return;
  }
  await interaction.update({ embeds: [verifiedSuccessEmbed(settings.verificationRoleId)], components: [], files: [] });
  await logToGuild(
    interaction.client,
    interaction.guildId,
    '✅ Verification Successful',
    amLogLine({ username: interaction.user.username, userId: interaction.user.id, roleId: settings.verificationRoleId })
  );
}

async function retryChallenge(interaction) {
  const challenge = generateChallenge(interaction.user.id, interaction.guildId);
  await interaction.update({
    embeds: [challengePrompt(challenge, { wrongAttempt: true })],
    components: challengeComponents(challenge),
    files: [],
  });
}

async function handleAmChallengePickButton(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const challenge = getActiveChallenge(interaction.user.id, interaction.guildId);
  if (!challenge) {
    await interaction.update({ content: 'This challenge expired. Click **Verify** again to get a new one.', embeds: [], components: [], files: [] });
    return;
  }

  const index = Number(interaction.customId.replace('amchal_pick_', ''));
  const picked = challenge.options[index];

  if (!checkAnswer(challenge, picked)) {
    await retryChallenge(interaction);
    return;
  }

  const settings = await getSettings();
  if (!settings.verificationRoleId) {
    await interaction.update({ embeds: [verificationNotConfiguredEmbed()], components: [], files: [] });
    return;
  }
  await finishVerification(interaction, settings);
}

async function handleAmChallengePickSelect(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const challenge = getActiveChallenge(interaction.user.id, interaction.guildId);
  if (!challenge) {
    await interaction.update({ content: 'This challenge expired. Click **Verify** again to get a new one.', embeds: [], components: [], files: [] });
    return;
  }

  const index = Number(interaction.values[0]);
  const picked = challenge.options[index];

  if (!checkAnswer(challenge, picked)) {
    await retryChallenge(interaction);
    return;
  }

  const settings = await getSettings();
  if (!settings.verificationRoleId) {
    await interaction.update({ embeds: [verificationNotConfiguredEmbed()], components: [], files: [] });
    return;
  }
  await finishVerification(interaction, settings);
}

async function handleAmChallengeOpenModal(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const challenge = getActiveChallenge(interaction.user.id, interaction.guildId);
  if (!challenge) {
    await interaction.reply({ content: 'This challenge expired. Click **Verify** again to get a new one.', ephemeral: true });
    return;
  }
  await interaction.showModal(wordChallengeModal());
}

async function handleAmChallengeWordModal(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const challenge = getActiveChallenge(interaction.user.id, interaction.guildId);
  if (!challenge) {
    const payload = { content: 'This challenge expired. Click **Verify** again to get a new one.', embeds: [], components: [], files: [] };
    if (interaction.isFromMessage?.()) await interaction.update(payload);
    else await interaction.reply({ ...payload, ephemeral: true });
    return;
  }

  const submitted = interaction.fields.getTextInputValue('answer').trim();

  if (!checkAnswer(challenge, submitted)) {
    await retryChallenge(interaction);
    return;
  }

  const settings = await getSettings();
  if (!settings.verificationRoleId) {
    await interaction.update({ embeds: [verificationNotConfiguredEmbed()], components: [], files: [] });
    return;
  }
  await finishVerification(interaction, settings);
}

// ── Action Model: Alpha / Code Gate ─────────────────────────────────

async function handleAmCodeStart(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;
  await interaction.showModal(codeModal());
}

async function handleAmCodeModalSubmit(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const settings = await getSettings();
  if (!settings.campaignRoleId) {
    await interaction.reply({ embeds: [codeFailEmbed('not_configured')], ephemeral: true });
    return;
  }

  const rawCode = interaction.fields.getTextInputValue('code').trim();
  await interaction.deferReply({ ephemeral: true });

  const result = await redeemCode({
    guildId: interaction.guildId,
    code: rawCode,
    userId: interaction.user.id,
    username: interaction.user.username,
  });

  if (!result.ok) {
    await interaction.editReply({ embeds: [codeFailEmbed(result.reason)] });
    return;
  }

  try {
    await assignGuildRole(interaction.client, interaction.guildId, interaction.user.id, result.code.roleId, `Redeemed code ${result.code.code}`);
  } catch (err) {
    console.error('[amcode] role assignment failed, releasing code:', err.message);
    await releaseCode(result.code.id);
    await interaction.editReply({ embeds: [codeFailEmbed('role_failed')] });
    return;
  }

  await interaction.editReply({ embeds: [codeSuccessEmbed(result.code.roleId, result.code.code)] });

  await logToGuild(
    interaction.client,
    interaction.guildId,
    '🎟️ Campaign Code Redeemed',
    `Code: ${result.code.code}\n` + amLogLine({ username: interaction.user.username, userId: interaction.user.id, roleId: result.code.roleId })
  );
}

// ── Action Model: /setup panel interactive menu ─────────────────────

async function handleAmSetupMenu(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const field = interaction.values[0];

  if (field === 'verificationRole' || field === 'campaignRole') {
    await interaction.update({ content: null, embeds: [], components: roleSelectRow(field) });
    return;
  }

  const settings = await getSettings();
  await interaction.showModal(textFieldModal(field, settings[field]));
}

async function refreshSetupSummary(interaction) {
  const settings = await getSettings();
  await interaction.update({ content: null, embeds: [summaryEmbed(settings)], components: menuRows(settings) });
}

async function handleAmSetupTextModal(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const field = interaction.customId.replace('amsetup_modal_', '');
  if (!TEXT_FIELD_META[field]) return;

  const raw = interaction.fields.getTextInputValue('value').trim();
  const value = field === 'embedImageUrl' && raw === '' ? null : raw;

  await updateSettings({ [field]: value });
  await refreshSetupSummary(interaction);
}

async function handleAmSetupRoleSelect(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const role = interaction.roles.first();
  if (interaction.customId === 'amsetup_roleselect_verification') {
    await updateSettings({ verificationRoleId: role.id });
  } else {
    await updateSettings({ campaignRoleId: role.id, campaignRoleName: role.name });
  }
  await refreshSetupSummary(interaction);
}

async function handleAmSetupPostPanel(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;
  if (!interaction.channel?.isTextBased()) return;

  await interaction.deferUpdate();
  const settings = await getSettings();

  try {
    const { updated } = await postOrUpdatePanel(interaction.client, settings, interaction.channel);
    await refreshAfterPost(interaction, updated);
  } catch (err) {
    console.error('[amsetup] failed to post/update panel:', err.message);
    await interaction.editReply({
      content: `⚠️ Couldn't post the panel here: ${err.message}`,
      embeds: [summaryEmbed(settings)],
      components: menuRows(settings),
    });
  }
}

async function refreshAfterPost(interaction, updated) {
  const settings = await getSettings();
  await interaction.editReply({
    content: updated ? '✅ Panel updated in place.' : '✅ Panel posted in this channel.',
    embeds: [summaryEmbed(settings)],
    components: menuRows(settings),
  });
}

// ── Role Panels ──────────────────────────────────────────────────────

async function handleRpWizardButton(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const draft = touchRolePanelDraft(interaction.user.id, interaction.guildId);
  if (!draft) {
    await interaction.reply({
      content: 'This panel draft has expired. Run `/role-panel create` or `/role-panel edit` again.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === 'rpwizard_set_info') {
    await interaction.showModal(infoModal(draft));
    return;
  }

  if (interaction.customId === 'rpwizard_add_button') {
    await interaction.showModal(addButtonModal());
    return;
  }

  if (interaction.customId === 'rpwizard_remove_button') {
    draft.buttons.pop();
    await interaction.update({ embeds: [rolePanelWizardEmbed(draft)], components: rolePanelWizardRows(draft) });
    return;
  }

  if (interaction.customId === 'rpwizard_cancel') {
    clearRolePanelDraft(interaction.user.id, interaction.guildId);
    await interaction.update({ content: 'Role panel draft cancelled.', embeds: [], components: [] });
    return;
  }

  if (interaction.customId === 'rpwizard_save') {
    await finishRolePanelWizard(interaction, draft);
  }
}

async function finishRolePanelWizard(interaction, draft) {
  await interaction.deferUpdate();

  try {
    const buttonData = draft.buttons.map((b, i) => ({
      label: b.label,
      emoji: b.emoji,
      style: b.style,
      roleId: b.roleId,
      roleName: b.roleName,
      position: i,
    }));

    let panel;
    if (draft.editingPanelId) {
      await prisma.rolePanelButton.deleteMany({ where: { panelId: draft.editingPanelId } });
      panel = await prisma.rolePanel.update({
        where: { id: draft.editingPanelId },
        data: {
          title: draft.title,
          description: draft.description,
          buttons: { create: buttonData },
        },
        include: { buttons: true },
      });
    } else {
      panel = await prisma.rolePanel.create({
        data: {
          guildId: draft.guildId,
          internalName: draft.internalName,
          title: draft.title,
          description: draft.description,
          createdByUserId: draft.createdByUserId,
          buttons: { create: buttonData },
        },
        include: { buttons: true },
      });
    }

    clearRolePanelDraft(interaction.user.id, interaction.guildId);

    if (panel.channelId && panel.messageId) {
      await postOrUpdateRolePanel(interaction.client, panel).catch((err) => {
        console.error('[rpwizard_save] failed to refresh posted panel:', err.message);
      });
      await interaction.editReply({ content: '✅ Saved — the live panel message has been updated.', embeds: [], components: [] });
    } else {
      await interaction.editReply({
        content: `✅ Saved **${panel.internalName}**. Post it with \`/role-panel repost name:${panel.internalName}\`.`,
        embeds: [],
        components: [],
      });
    }

    await logToGuild(
      interaction.client,
      draft.guildId,
      draft.editingPanelId ? '🎛️ Role Panel Edited' : '📋 Role Panel Created',
      `Panel: ${panel.title}\n${draft.editingPanelId ? 'Edited' : 'Created'} by <@${draft.createdByUserId}>`
    );
  } catch (err) {
    console.error('[rpwizard_save]', err);
    await interaction.editReply({ content: `⚠️ Couldn't save: ${err.message}`, embeds: [], components: [] });
  }
}

async function handleRpWizardModalSubmit(interaction) {
  const draft = touchRolePanelDraft(interaction.user.id, interaction.guildId);
  if (!draft) {
    await interaction.reply({
      content: 'This panel draft has expired. Run `/role-panel create` or `/role-panel edit` again.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === 'rpwizard_modal_info') {
    draft.title = interaction.fields.getTextInputValue('title').trim();
    draft.description = interaction.fields.getTextInputValue('description').trim();
    await interaction.update({ embeds: [rolePanelWizardEmbed(draft)], components: rolePanelWizardRows(draft) });
    return;
  }

  if (interaction.customId === 'rpwizard_modal_button') {
    if (draft.buttons.length >= 25) {
      await interaction.reply({ content: 'This panel already has the maximum of 25 buttons.', ephemeral: true });
      return;
    }

    const label = interaction.fields.getTextInputValue('label').trim();
    const emojiRaw = interaction.fields.getTextInputValue('emoji').trim();
    const roleId = interaction.fields.getTextInputValue('role_id').trim();
    const styleRaw = interaction.fields.getTextInputValue('style').trim();

    const style = normalizeStyle(styleRaw);
    if (!style) {
      await interaction.reply({ content: `❌ Style must be one of: ${VALID_STYLES.join(', ')}.`, ephemeral: true });
      return;
    }

    const role = interaction.guild.roles.cache.get(roleId) || (await interaction.guild.roles.fetch(roleId).catch(() => null));
    if (!role) {
      await interaction.reply({
        content: `❌ Couldn't find a role with ID \`${roleId}\` in this server. Double-check the ID.`,
        ephemeral: true,
      });
      return;
    }

    draft.buttons.push({ label, emoji: emojiRaw || null, style, roleId: role.id, roleName: role.name });
    await interaction.update({ embeds: [rolePanelWizardEmbed(draft)], components: rolePanelWizardRows(draft) });
  }
}

async function handleRolePanelButtonClick(interaction) {
  if (!isActionModelGuild(interaction.guildId)) return;

  const parts = interaction.customId.split('_');
  const panelId = parts[1];
  const buttonId = parts[2];

  await interaction.deferReply({ ephemeral: true });

  const result = await handleRolePanelClick(interaction.client, interaction, panelId, buttonId);

  if (result.result === 'panel_missing' || result.result === 'button_missing') {
    await interaction.editReply({ content: 'This panel no longer exists.' });
    return;
  }
  if (result.result === 'role_missing') {
    await interaction.editReply({ embeds: [roleMissingEmbed()] });
    return;
  }
  if (result.result === 'role_assign_failed') {
    await interaction.editReply({ content: '⚠️ Couldn\u2019t assign that role — a permissions issue. An admin has been notified.' });
    return;
  }

  await interaction.editReply({ embeds: [roleSelectionEmbed(result.result, result.roleName)] });
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
      if (interaction.customId === 'amverify_start') {
        await handleAmVerifyStart(interaction);
        return;
      }
      if (interaction.customId === 'amcode_start') {
        await handleAmCodeStart(interaction);
        return;
      }
      if (interaction.customId === 'amchal_openmodal') {
        await handleAmChallengeOpenModal(interaction);
        return;
      }
      if (interaction.customId.startsWith('amchal_pick_')) {
        await handleAmChallengePickButton(interaction);
        return;
      }
      if (interaction.customId === 'amsetup_post_panel') {
        await handleAmSetupPostPanel(interaction);
        return;
      }
      if (interaction.customId.startsWith('rpwizard_')) {
        await handleRpWizardButton(interaction);
        return;
      }
      if (interaction.customId.startsWith('rolepanel_')) {
        await handleRolePanelButtonClick(interaction);
        return;
      }
      return;
    }
    if (interaction.isRoleSelectMenu()) {
      if (interaction.customId.startsWith('amsetup_roleselect_')) {
        await handleAmSetupRoleSelect(interaction);
      }
      return;
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'amchal_pick_select') {
        await handleAmChallengePickSelect(interaction);
        return;
      }
      if (interaction.customId === 'amsetup_menu') {
        await handleAmSetupMenu(interaction);
        return;
      }
      await handleSelectMenu(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'amcode_modal') {
        await handleAmCodeModalSubmit(interaction);
        return;
      }
      if (interaction.customId === 'amchal_modal_word') {
        await handleAmChallengeWordModal(interaction);
        return;
      }
      if (interaction.customId.startsWith('amsetup_modal_')) {
        await handleAmSetupTextModal(interaction);
        return;
      }
      if (interaction.customId === 'rpwizard_modal_info' || interaction.customId === 'rpwizard_modal_button') {
        await handleRpWizardModalSubmit(interaction);
        return;
      }
      await handleModalSubmit(interaction);
    }
  },
};
