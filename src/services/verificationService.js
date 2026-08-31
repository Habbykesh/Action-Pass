const { prisma } = require('../database/connect');
const { assignCampaignRole, removeCampaignRole } = require('./roleService');
const { logToCampaignGuilds } = require('./logService');

/**
 * Checks a user's membership across every server required by a
 * campaign. Returns a map of guildId -> boolean, plus whether all are
 * satisfied.
 */
async function checkMembership(client, campaign, userId) {
  const statusMap = {};

  await Promise.all(
    campaign.requiredServers.map(async (server) => {
      const guild = client.guilds.cache.get(server.guildId);
      if (!guild) {
        statusMap[server.guildId] = false;
        return;
      }
      const member = await guild.members.fetch(userId).catch(() => null);
      statusMap[server.guildId] = Boolean(member);
    })
  );

  const allPresent = campaign.requiredServers.every((s) => statusMap[s.guildId]);
  return { statusMap, allPresent };
}

/**
 * Handles a single verification attempt (the "Verify Membership"
 * button). Returns { alreadyVerified, allPresent, statusMap }.
 */
async function handleVerificationAttempt(client, campaign, userId, username) {
  const existing = await prisma.campaignMember.findUnique({
    where: { campaignId_userId: { campaignId: campaign.id, userId } },
  });

  if (existing?.eligible) {
    return { alreadyVerified: true, allPresent: true, statusMap: existing.serverStatus };
  }

  const { statusMap, allPresent } = await checkMembership(client, campaign, userId);
  const now = new Date();

  const member = await prisma.campaignMember.upsert({
    where: { campaignId_userId: { campaignId: campaign.id, userId } },
    update: {
      lastKnownUsername: username,
      serverStatus: statusMap,
      eligible: allPresent,
      lastCheckedAt: now,
      firstVerifiedAt: allPresent ? existing?.firstVerifiedAt || now : existing?.firstVerifiedAt || null,
    },
    create: {
      campaignId: campaign.id,
      userId,
      lastKnownUsername: username,
      serverStatus: statusMap,
      eligible: allPresent,
      lastCheckedAt: now,
      firstVerifiedAt: allPresent ? now : null,
    },
  });

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { verificationActivityCount: { increment: 1 } },
  });

  if (allPresent) {
    const assigned = await assignCampaignRole(client, campaign, userId);
    if (assigned) {
      await prisma.campaignMember.update({
        where: { id: member.id },
        data: { roleAssigned: true },
      });
    }

    await logToCampaignGuilds(
      client,
      campaign,
      '✅ Member Verified',
      `<@${userId}>\n${campaign.name}\nRole assigned: ${campaign.roleName}`
    );
  }

  return { alreadyVerified: false, allPresent, statusMap };
}

/**
 * Re-checks a single user's eligibility for a single campaign — used
 * when someone leaves a required server, or during a manual/periodic
 * recheck. Removes the role and flips eligibility off if they no
 * longer qualify.
 */
async function recheckMember(client, campaign, campaignMember) {
  const { statusMap, allPresent } = await checkMembership(client, campaign, campaignMember.userId);

  if (campaignMember.eligible && !allPresent) {
    await removeCampaignRole(client, campaign, campaignMember.userId);

    const missing = campaign.requiredServers.find((s) => !statusMap[s.guildId]);
    await logToCampaignGuilds(
      client,
      campaign,
      '🚪 Membership Change',
      `<@${campaignMember.userId}> left ${missing?.name || 'a required server'}\n${campaign.name} role removed`
    );
  }

  await prisma.campaignMember.update({
    where: { id: campaignMember.id },
    data: {
      serverStatus: statusMap,
      eligible: allPresent,
      roleAssigned: allPresent ? campaignMember.roleAssigned : false,
      lastCheckedAt: new Date(),
    },
  });

  return allPresent;
}

/**
 * Rechecks every tracked member of a campaign (used by /campaign
 * recheck and the periodic background sweep).
 */
async function recheckCampaign(client, campaign) {
  const members = await prisma.campaignMember.findMany({ where: { campaignId: campaign.id } });
  let becameIneligible = 0;

  for (const member of members) {
    const stillEligible = await recheckMember(client, campaign, member);
    if (member.eligible && !stillEligible) becameIneligible++;
  }

  return { checked: members.length, becameIneligible };
}

/**
 * Called from the guildMemberRemove event: finds every active campaign
 * that requires the guild the user just left, and rechecks their
 * eligibility for each one.
 */
async function handleMemberLeftGuild(client, guildId, userId) {
  const campaigns = await prisma.campaign.findMany({
    where: {
      status: 'active',
      requiredServers: { some: { guildId } },
    },
    include: { requiredServers: true },
  });

  for (const campaign of campaigns) {
    const member = await prisma.campaignMember.findUnique({
      where: { campaignId_userId: { campaignId: campaign.id, userId } },
    });
    if (member?.eligible) {
      await recheckMember(client, campaign, member);
    }
  }
}

module.exports = {
  checkMembership,
  handleVerificationAttempt,
  recheckMember,
  recheckCampaign,
  handleMemberLeftGuild,
};
