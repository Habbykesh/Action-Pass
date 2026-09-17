const { PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const { prisma } = require('../database/connect');

function isBotOwner(userId) {
  return config.ownerIds.includes(userId);
}

function isServerAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

/**
 * The Alpha/Code Gate management commands (/generate-codes, /codes)
 * require Discord's Manage Server permission — deliberately looser
 * than the Administrator-only /campaign and /setup commands, per spec.
 */
function hasManageGuild(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

/**
 * The Alpha Gate and Visual Verification Gate are exclusive to the
 * Action Model server. Slash commands are registered globally, so this
 * runtime check is what actually enforces that — not Discord's
 * per-command permission system, which only gates *who* can run a
 * command within a guild, not *which* guild it works in.
 */
function isActionModelGuild(guildId) {
  return guildId === config.actionModelGuildId;
}

/**
 * Determines whether the given guild is allowed to create/manage its own
 * partnership campaigns. The home guild (ActionFi's own server) always
 * has access. Otherwise it depends on the global partner access toggle
 * or an explicit per-guild override.
 */
async function hasCampaignAccess(guildId) {
  if (guildId === config.homeGuildId) return true;

  const settings = await prisma.botSettings.findUnique({ where: { id: 1 } });
  if (settings?.globalPartnerAccess) return true;

  const guildConfig = await prisma.guildConfig.findUnique({ where: { guildId } });
  return Boolean(guildConfig?.campaignAccess);
}

module.exports = {
  isBotOwner,
  isServerAdmin,
  hasCampaignAccess,
  hasManageGuild,
  isActionModelGuild,
};
