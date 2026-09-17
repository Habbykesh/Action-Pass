const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const FIELD_OPTIONS = [
  { value: 'embedTitle', label: 'Embed Title', emoji: '📝' },
  { value: 'embedDescription', label: 'Embed Description', emoji: '📄' },
  { value: 'embedImageUrl', label: 'Embed Image URL', emoji: '🖼️' },
  { value: 'verifyButtonLabel', label: 'Verify Button Label', emoji: '✅' },
  { value: 'verificationRole', label: 'Verification Role', emoji: '🎭' },
  { value: 'campaignButtonLabel', label: 'Campaign Button Label', emoji: '🏆' },
  { value: 'campaignRole', label: 'Campaign / Alpha Role', emoji: '🎟️' },
];

function truncate(str, n) {
  if (!str) return '_not set_';
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function summaryEmbed(settings) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('⚙️ Action Model — Verification & Alpha Gate Setup')
    .addFields(
      { name: 'Embed Title', value: truncate(settings.embedTitle, 100), inline: true },
      { name: 'Embed Image', value: settings.embedImageUrl ? 'set' : '_not set_', inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Embed Description', value: truncate(settings.embedDescription, 300) },
      { name: 'Verify Button Label', value: settings.verifyButtonLabel, inline: true },
      { name: 'Verification Role', value: settings.verificationRoleId ? `<@&${settings.verificationRoleId}>` : '_not set_', inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Campaign Button Label', value: settings.campaignButtonLabel, inline: true },
      { name: 'Campaign / Alpha Role', value: settings.campaignRoleId ? `<@&${settings.campaignRoleId}>` : '_not set_', inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      {
        name: 'Panel Message',
        value: settings.panelChannelId ? `Posted in <#${settings.panelChannelId}> — editing will update it in place.` : '_Not posted yet — use the button below._',
      }
    )
    .setFooter({ text: 'Pick a field below to edit it, or post/update the live panel.' });
}

function menuRows(settings) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('amsetup_menu')
    .setPlaceholder('Choose what to edit…')
    .addOptions(FIELD_OPTIONS);

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('amsetup_post_panel')
      .setLabel(settings.panelChannelId ? 'Update Panel In This Channel' : 'Post Panel In This Channel')
      .setEmoji('📌')
      .setStyle(ButtonStyle.Success)
  );

  return [new ActionRowBuilder().addComponents(select), actionRow];
}

const TEXT_FIELD_META = {
  embedTitle: { label: 'Embed Title', style: TextInputStyle.Short, maxLength: 256 },
  embedDescription: { label: 'Embed Description (up to 4096 chars)', style: TextInputStyle.Paragraph, maxLength: 4000 },
  embedImageUrl: { label: 'Embed Image URL (leave blank to clear)', style: TextInputStyle.Short, maxLength: 500, required: false },
  verifyButtonLabel: { label: 'Verify Button Label', style: TextInputStyle.Short, maxLength: 80 },
  campaignButtonLabel: { label: 'Campaign Button Label', style: TextInputStyle.Short, maxLength: 80 },
};

function textFieldModal(field, currentValue) {
  const meta = TEXT_FIELD_META[field];
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(meta.label)
    .setStyle(meta.style)
    .setRequired(meta.required !== false)
    .setMaxLength(meta.maxLength);
  if (currentValue) input.setValue(String(currentValue).slice(0, meta.maxLength));

  return new ModalBuilder()
    .setCustomId(`amsetup_modal_${field}`)
    .setTitle('Edit Setting')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function roleSelectRow(field) {
  const customId = field === 'verificationRole' ? 'amsetup_roleselect_verification' : 'amsetup_roleselect_campaign';
  const placeholder = field === 'verificationRole' ? 'Select the Verification role' : 'Select the Campaign / Alpha role';
  const select = new RoleSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1);
  return [new ActionRowBuilder().addComponents(select)];
}

module.exports = {
  FIELD_OPTIONS,
  TEXT_FIELD_META,
  summaryEmbed,
  menuRows,
  textFieldModal,
  roleSelectRow,
};
