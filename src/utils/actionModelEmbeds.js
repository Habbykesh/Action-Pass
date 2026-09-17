const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
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

function challengePrompt(challenge, { wrongAttempt = false } = {}) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('🧠 Quick Verification');

  if (challenge.type === 'emoji') {
    embed.setDescription(`Click the ${challenge.answer} (**${challenge.promptLabel}**) button below.`);
  } else if (challenge.type === 'math') {
    embed.setDescription(`Select the correct answer: **${challenge.promptLabel} = ?**`);
  } else {
    embed.setDescription(`Type this word exactly: **${challenge.promptLabel}**`);
  }

  if (wrongAttempt) {
    embed.addFields({ name: '❌ Incorrect', value: 'That wasn\u2019t it — here\u2019s a new challenge, try again.' });
  }

  return embed;
}

function challengeComponents(challenge) {
  if (challenge.type === 'word') {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('amchal_openmodal').setLabel('Enter the word').setStyle(ButtonStyle.Primary)
      ),
    ];
  }

  if (challenge.type === 'emoji') {
    const row = new ActionRowBuilder().addComponents(
      challenge.options.map((emoji, i) =>
        new ButtonBuilder().setCustomId(`amchal_pick_${i}`).setEmoji(emoji).setStyle(ButtonStyle.Secondary)
      )
    );
    return [row];
  }

  // math challenge — dropdown of numeric answers
  const select = new StringSelectMenuBuilder()
    .setCustomId('amchal_pick_select')
    .setPlaceholder('Select the correct answer')
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

function wordChallengeModal() {
  const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
  return new ModalBuilder()
    .setCustomId('amchal_modal_word')
    .setTitle('Enter the Word')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('answer')
          .setLabel('Type the word exactly as shown')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
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
  challengePrompt,
  challengeComponents,
  verifiedSuccessEmbed,
  verificationNotConfiguredEmbed,
  codeModal,
  wordChallengeModal,
  codeSuccessEmbed,
  codeFailEmbed,
};
