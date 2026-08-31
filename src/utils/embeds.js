const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const COLOR = 0x8b5cf6; // violet — matches the ActionFi brand mark
const COLOR_SUCCESS = 0x57f287;
const COLOR_FAIL = 0xed4245;
const COLOR_LOG = 0x99aab5;
const BRAND_FOOTER = 'ActionFi Partnerships';

function verificationEmbed(campaign, iconUrl) {
  const serverLines = campaign.requiredServers
    .map((s) => `🔹 [${s.name}](${s.inviteLink})`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: 'Campaign Verification' })
    .setTitle(`🤝  ${campaign.name}`)
    .setDescription('You must be a member of **all** the communities below to participate in this campaign.')
    .addFields(
      { name: '📋  Required Communities', value: serverLines },
      {
        name: '🕒  Verification Window',
        value: `${campaign.startAt.toDateString()} → **${campaign.deadlineAt.toDateString()}**`,
      }
    )
    .setFooter({ text: `${BRAND_FOOTER} • Closes ${campaign.deadlineAt.toDateString()}` })
    .setTimestamp();

  if (iconUrl) embed.setThumbnail(iconUrl);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`verify_${campaign.id}`)
      .setLabel('Verify Membership')
      .setEmoji('🔐')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

function eligibleEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_SUCCESS)
    .setTitle('✅  You\u2019re already verified!')
    .setDescription('You are a member of all required communities and are eligible for this campaign.')
    .setFooter({ text: BRAND_FOOTER });
}

function successEmbed(campaign) {
  return new EmbedBuilder()
    .setColor(COLOR_SUCCESS)
    .setTitle('✅  Verified!')
    .setDescription(`You now belong to all required communities for **${campaign.name}**.`)
    .addFields({ name: '🎖️  Role Assigned', value: campaign.roleName })
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();
}

function missingServersEmbed(campaign, statusMap) {
  const lines = campaign.requiredServers
    .map((s) => `${statusMap[s.guildId] ? '✅' : '❌'}  [${s.name}](${s.inviteLink})`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(COLOR_FAIL)
    .setTitle('❌  You\u2019re not eligible yet')
    .addFields({ name: 'Community Status', value: lines })
    .setDescription('Join the missing communities above, then tap **Verify Membership** again.')
    .setFooter({ text: BRAND_FOOTER });
}

function campaignNotActiveEmbed(campaign) {
  const now = new Date();
  let reason = 'This campaign is no longer accepting verifications.';
  if (campaign.status !== 'active') {
    reason = `This campaign has been ${campaign.status}.`;
  } else if (now < campaign.startAt) {
    reason = `This campaign hasn\u2019t started yet. It opens ${campaign.startAt.toUTCString()}.`;
  } else if (now > campaign.deadlineAt) {
    reason = `This campaign\u2019s verification deadline (${campaign.deadlineAt.toUTCString()}) has passed.`;
  }
  return new EmbedBuilder()
    .setColor(COLOR_FAIL)
    .setTitle('🔒  Verification Closed')
    .setDescription(reason)
    .setFooter({ text: BRAND_FOOTER });
}

function accessDeniedEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_FAIL)
    .setTitle('🔒  Access Required')
    .setDescription('You don\u2019t currently have permission to create campaigns with this bot.\n\nPlease contact the bot developer to request access.')
    .setFooter({ text: BRAND_FOOTER });
}

function logEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(COLOR_LOG)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();
}

function wizardEmbed(draft) {
  const serverLines = draft.requiredServers.length
    ? draft.requiredServers
        .map((s, i) => `${i + 1}. **${s.name}** (\`${s.guildId}\`)`)
        .join('\n')
    : '_No servers added yet — you need at least 2._';

  const roleLine = draft.roleServerId
    ? `Role lives in: \`${draft.roleServerId}\`${draft.existingRoleId ? ` (existing role \`${draft.existingRoleId}\`)` : ' (auto-created role)'}`
    : '_Not set yet._';

  const dateLine =
    draft.startAt && draft.deadlineAt
      ? `${draft.startAt.toUTCString()} → ${draft.deadlineAt.toUTCString()}`
      : '_Not set yet._';

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`📋  Draft Campaign: ${draft.name}`)
    .addFields(
      { name: '🌐  Required Servers', value: serverLines },
      { name: '🎭  Verification Role', value: roleLine },
      { name: '🕒  Verification Period', value: dateLine }
    )
    .setFooter({ text: 'Use the buttons below to complete setup, then Finish & Create.' });
}

function wizardRows(draft) {
  const canFinish =
    draft.requiredServers.length >= 2 && draft.roleServerId && draft.startAt && draft.deadlineAt;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wizard_add_server').setLabel('Add Server').setEmoji('➕').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('wizard_set_role').setLabel('Set Role').setEmoji('🎭').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('wizard_set_dates').setLabel('Set Dates').setEmoji('🗓️').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wizard_finish')
      .setLabel('Finish & Create')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canFinish),
    new ButtonBuilder().setCustomId('wizard_cancel').setLabel('Cancel').setEmoji('✖').setStyle(ButtonStyle.Danger)
  );
  return [row1, row2];
}

module.exports = {
  COLOR,
  COLOR_SUCCESS,
  COLOR_FAIL,
  verificationEmbed,
  eligibleEmbed,
  successEmbed,
  missingServersEmbed,
  campaignNotActiveEmbed,
  accessDeniedEmbed,
  logEmbed,
  wizardEmbed,
  wizardRows,
};
