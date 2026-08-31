const { prisma } = require('../database/connect');
const { logEmbed } = require('../utils/embeds');

/**
 * Sends a log embed to a single guild's configured log channel, if one
 * has been set up via /setup. Silently no-ops otherwise.
 */
async function logToGuild(client, guildId, title, description) {
  try {
    const guildConfig = await prisma.guildConfig.findUnique({ where: { guildId } });
    if (!guildConfig?.logChannelId) return;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const channel = guild.channels.cache.get(guildConfig.logChannelId);
    if (!channel?.isTextBased()) return;

    await channel.send({ embeds: [logEmbed(title, description)] });
  } catch (err) {
    console.error(`[logService] Failed to log to guild ${guildId}:`, err.message);
  }
}

/**
 * Logs an event to every server participating in a campaign (its
 * required servers plus the role server), de-duplicated, since all of
 * them have a stake in that campaign's activity.
 */
async function logToCampaignGuilds(client, campaign, title, description) {
  const guildIds = new Set([
    campaign.ownerGuildId,
    campaign.roleServerId,
    ...campaign.requiredServers.map((s) => s.guildId),
  ]);

  await Promise.all(
    [...guildIds].map((guildId) => logToGuild(client, guildId, title, description))
  );
}

module.exports = { logToGuild, logToCampaignGuilds };
