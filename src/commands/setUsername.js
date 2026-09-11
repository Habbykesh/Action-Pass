const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { prisma } = require('../database/connect');

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{2,32}$/;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-username')
    .setDescription('[Admin] Set or override a member\u2019s linked username.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) => opt.setName('member').setDescription('The member to update').setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName('username')
        .setDescription('2-32 characters: letters, numbers, underscores only')
        .setRequired(true)
    ),

  async execute(interaction) {
    const member = interaction.options.getUser('member');
    const raw = interaction.options.getString('username').trim();

    if (!USERNAME_PATTERN.test(raw)) {
      await interaction.reply({
        content: '❌ Usernames must be 2-32 characters, letters/numbers/underscores only.',
        ephemeral: true,
      });
      return;
    }

    const usernameLower = raw.toLowerCase();
    const taken = await prisma.linkedUsername.findUnique({ where: { usernameLower } });
    if (taken && taken.discordUserId !== member.id) {
      await interaction.reply({
        content: `❌ **${raw}** is already linked to <@${taken.discordUserId}>. Choose a different username, or update that account instead.`,
        ephemeral: true,
      });
      return;
    }

    await prisma.linkedUsername.upsert({
      where: { discordUserId: member.id },
      update: {
        username: raw,
        usernameLower,
        lockedByUser: false,
        setByAdminId: interaction.user.id,
      },
      create: {
        discordUserId: member.id,
        username: raw,
        usernameLower,
        lockedByUser: false,
        setByAdminId: interaction.user.id,
      },
    });

    await interaction.reply({
      content: `✅ <@${member.id}>'s linked username is now **${raw}**.`,
      ephemeral: true,
    });
  },
};
