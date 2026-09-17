const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder,
} = require('discord.js');

const COLOR = 0x5865f2;
const COLOR_SUCCESS = 0x57f287;
const COLOR_FAIL = 0xed4245;

function panelEmbed(settings) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(settings.embedTitle)
    .setDescription(settings.embedDescription);
  if (settings.embedImageUrl) embed.setImage(settings.embedImageUrl);
  return embed;
}

function panelRows(settings) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('amverify_start').setLabel(settings.verifyButtonLabel).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('amcode_start').setLabel(settings.campaignButtonLabel).setStyle(ButtonStyle.Primary)
  );
  return [row];
}

function alreadyVerifiedEmbed() {
  return new EmbedBuilder().setColor(COLOR_SUCCESS).setDescription('✅ You’re already Verified.');
}

function challengeAttachment(challenge) {
  return new AttachmentBuilder(challenge.image, { name: 'challenge.png' });
}

function challengePrompt(challenge, { wrongAttempt = false } = {}) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🔎 Visual Verification')
    .setImage('attachment://challenge.png');

  if (challenge.type === 'letters') {
    embed.setDescription('Look at the image and select the sequence you saw.');
  } else if (challenge.type === 'number') {
    embed.setDescription('Look at the image, then click below and type the number you saw.');
  } else {
    embed.setDescription('Look at the image and select the object you saw.');
  }

  if (wrongAttempt) {
    embed.addFields({ name: '❌ Incorrect', value: 'That wasn’t it — here’s a new challenge, try again.' });
  }

  return embed;
}

function challengeComponents(challenge) {
  if (challenge.type === 'number') {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('amchal_openmodal').setLabel('Enter the number').setStyle(ButtonStyle.Primary)
      ),
    ];
  }

  if (challenge.type === 'letters') {
    const row = new ActionRowBuilder().addComponents(
      challenge.options.map((opt, i) =>
        new ButtonBuilder().setCustomId(`amchal_pick_${i}`).setLabel(opt).setStyle(ButtonStyle.Secondary)
      )
    );
    return [row];
  }

  // object challenge — dropdown
  const select = new StringSelectMenuBuilder()
    .setCustomId('amchal_pick_select')
    .setPlaceholder('Select the object you saw')
    .addOptions(challenge.options.map((opt, i) => ({ label: opt, value: String(i) })));
  return [new ActionRowBuilder().addComponents(select)];
}

function verifiedSuccessEmbed(roleId) {
  return new EmbedBuilder()
    .setColor(COLOR_SUCCESS)
    .setTitle('✅ Verified!')
    .setDescription(`You've been given <@&${roleId}>.`);
}

function verificationNotConfiguredEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_FAIL)
    .setTitle('⚠️ Not Configured')
    .setDescription('An admin hasn’t set a verification role yet. Run `/setup panel` to configure it.');
}

function codeModal() {
  const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
  return new ModalBuilder()
    .setCustomId('amcode_modal')
    .setTitle('Enter Access Code')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('code')
          .setLabel('Code (e.g. PASS-4827)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
      )
    );
}

function numberChallengeModal() {
  const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
  return new ModalBuilder()
    .setCustomId('amchal_modal_number')
    .setTitle('Enter the Number')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('answer')
          .setLabel('The number you saw')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12)
      )
    );
}

function codeSuccessEmbed(roleId, code) {
  return new EmbedBuilder()
    .setColor(COLOR_SUCCESS)
    .setTitle('🎟️ Code Accepted!')
    .setDescription(`**${code}** redeemed. You've been given <@&${roleId}>.`);
}

function codeFailEmbed(reason) {
  const messages = {
    not_found: '❌ That code isn’t valid.',
    already_used: '❌ That code has already been used.',
    role_failed:
      '⚠️ Your code was valid, but the role couldn’t be assigned (a permissions or role-hierarchy issue). Your code has **not** been consumed — please try again or contact an admin.',
    not_configured: '⚠️ An admin hasn’t set a campaign role yet. Run `/setup panel` to configure it.',
  };
  return new EmbedBuilder().setColor(COLOR_FAIL).setDescription(messages[reason] || '❌ Something went wrong.');
}

module.exports = {
  panelEmbed,
  panelRows,
  alreadyVerifiedEmbed,
  challengeAttachment,
  challengePrompt,
  challengeComponents,
  verifiedSuccessEmbed,
  verificationNotConfiguredEmbed,
  codeModal,
  numberChallengeModal,
  codeSuccessEmbed,
  codeFailEmbed,
};
