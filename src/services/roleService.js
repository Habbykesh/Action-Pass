const { prisma } = require('../database/connect');

/**
 * Creates the campaign role in the designated role server, or returns
 * the existing role's ID if the campaign creator chose an existing role
 * instead of auto-creating one.
 */
async function createOrResolveCampaignRole(client, { roleServerId, roleName, existingRoleId }) {
  const guild = await client.guilds.fetch(roleServerId);

  if (existingRoleId) {
    const role = await guild.roles.fetch(existingRoleId).catch(() => null);
    if (!role) {
      throw new Error(
        `Could not find role ${existingRoleId} in the selected role server. Double-check the role ID.`
      );
    }
    return { roleId: role.id, roleAutoCreated: false };
  }

  const role = await guild.roles.create({
    name: roleName,
    reason: 'ActionFi partnership campaign role (auto-created)',
    mentionable: false,
  });

  return { roleId: role.id, roleAutoCreated: true };
}

async function assignCampaignRole(client, campaign, userId) {
  const guild = await client.guilds.fetch(campaign.roleServerId).catch(() => null);
  if (!guild) return false;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;

  if (!member.roles.cache.has(campaign.roleId)) {
    await member.roles.add(campaign.roleId, `Verified for campaign: ${campaign.name}`);
  }
  return true;
}

async function removeCampaignRole(client, campaign, userId) {
  const guild = await client.guilds.fetch(campaign.roleServerId).catch(() => null);
  if (!guild) return false;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;

  if (member.roles.cache.has(campaign.roleId)) {
    await member.roles.remove(campaign.roleId, `No longer eligible for campaign: ${campaign.name}`);
  }
  return true;
}

/**
 * Generic single-guild role grant used by the Action Model Alpha/
 * Verification gates (unlike the cross-server campaign roles above,
 * these always live in the same guild the interaction happened in).
 * Throws on a Discord permission/role-hierarchy failure rather than
 * swallowing it, since callers need to distinguish "failed" from
 * "succeeded" to decide whether to consume an access code.
 *
 * Takes the GuildMember directly (e.g. `interaction.member`) rather
 * than a guildId/userId pair to fetch — every caller already has one
 * from the gateway cache, and the two extra REST round-trips
 * (guilds.fetch + members.fetch) that used to happen here were slow
 * enough on their own to occasionally blow through Discord's 3-second
 * interaction ack window, which surfaces as a confusing "Unknown
 * interaction" (10062) error on the *next* call, not this one.
 */
async function assignGuildRole(member, roleId, reason) {
  if (member.roles.cache.has(roleId)) return { alreadyHad: true };
  await member.roles.add(roleId, reason);
  return { alreadyHad: false };
}

function memberHasRole(member, roleId) {
  return Boolean(member?.roles.cache.has(roleId));
}

module.exports = {
  createOrResolveCampaignRole,
  assignCampaignRole,
  removeCampaignRole,
  assignGuildRole,
  memberHasRole,
};
