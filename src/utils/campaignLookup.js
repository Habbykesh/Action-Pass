const { prisma } = require('../database/connect');

// A campaign should be visible/manageable from ANY server that's
// actually part of it — the guild that created it, the guild holding
// the role, or any of the required servers — not just the exact guild
// it was created from. This is what lets a partner server look up and
// repost a campaign it's participating in.
function campaignVisibilityWhere(guildId) {
  return {
    OR: [
      { ownerGuildId: guildId },
      { roleServerId: guildId },
      { requiredServers: { some: { guildId } } },
    ],
  };
}

async function findCampaignChoices(guildId) {
  return prisma.campaign.findMany({
    where: campaignVisibilityWhere(guildId),
    include: { requiredServers: true },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
}

async function findCampaignByName(guildId, name) {
  return prisma.campaign.findFirst({
    where: { name, ...campaignVisibilityWhere(guildId) },
    include: { requiredServers: true },
  });
}

module.exports = { campaignVisibilityWhere, findCampaignChoices, findCampaignByName };
