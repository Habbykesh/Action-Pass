const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { prisma } = require('../database/connect');
const { verificationEmbed } = require('../utils/embeds');
const { findCampaignChoices, findCampaignByName } = require('../utils/campaignLookup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('campaign-repost')
    .setDescription('Post (or repost) a campaign\u2019s verification embed in this server.')
    .addStringOption((opt) =>
      opt.setName('campaign').setDescription('Campaign name').setRequired(true).setAutocomplete(true)
    )
    .addChannelOption((opt) =>
      opt.setName('channel').setDescription('Channel to post in (defaults to this channel)').addChannelTypes(ChannelType.GuildText)
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const campaigns = await findCampaignChoices(interaction.guildId);
    const filtered = campaigns
      .filter((c) => c.name.toLowerCase().includes(String(focused).toLowerCase()))
      .slice(0, 25);
    await interaction.respond(filtered.map((c) => ({ name: `${c.name} (${c.status})`, value: c.name })));
  },

  async execute(interaction) {
    const name = interaction.options.getString('campaign');
    const campaign = await findCampaignByName(interaction.guildId, name);
    if (!campaign) {
      await interaction.reply({
        content: 'Campaign not found here. Ask ActionFi to confirm the exact campaign name.',
        ephemeral: true,
      });
      return;
    }

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
  },
};
