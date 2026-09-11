const { SlashCommandBuilder } = require('discord.js');
const { prisma } = require('../database/connect');

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{2,32}$/;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('link-username')
    .setDescription('Link a username to your account for reports (one-time — an admin can change it after).')
    .addStringOption((opt) =>
      opt
        .setName('username')
        .setDescription('2-32 characters: letters, numbers, underscores only')
        .setRequired(true)
    ),

  async execute(interaction) {
    const raw = interaction.options.getString('username').trim();

    if (!USERNAME_PATTERN.test(raw)) {
      await interaction.reply({
        content: '❌ Usernames must be 2-32 characters, letters/numbers/underscores only.',
        ephemeral: true,
      });
      return;
    }

    const existing = await prisma.linkedUsername.findUnique({
      where: { discordUserId: interaction.user.id },
    });

    if (existing) {
      await interaction.reply({
        content: `🔒 You've already linked **${existing.username}**. Usernames can't be changed once set — ask a server admin to update it if needed.`,
        ephemeral: true,
      });
      return;
    }

    const usernameLower = raw.toLowerCase();
    const taken = await prisma.linkedUsername.findUnique({ where: { usernameLower } });
    if (taken) {
      await interaction.reply({
        content: '❌ That username is already linked to another account. Pick a different one.',
        ephemeral: true,
      });
      return;
    }

    await prisma.linkedUsername.create({
      data: {
        discordUserId: interaction.user.id,
        username: raw,
        usernameLower,
        lockedByUser: true,
      },
    });

    await interaction.reply({
      content: `✅ Linked! Your username is now **${raw}**. This is permanent unless an admin changes it.`,
      ephemeral: true,
    });
  },
};
