const { prisma } = require('../database/connect');
const { logToGuild } = require('./logService');

/**
 * Posts a panel if it's never been posted, or edits the existing
 * message in place otherwise — so editing wording/buttons/roles through
 * /role-panel edit never spawns a duplicate message. Mirrors
 * actionModelSettingsService.postOrUpdatePanel.
 */
async function postOrUpdatePanel(client, panel, channel) {
  const { rolePanelPostEmbed, rolePanelPostRows } = require('../utils/rolePanelEmbeds');
  const payload = { embeds: [rolePanelPostEmbed(panel)], components: rolePanelPostRows(panel) };

  if (panel.channelId && panel.messageId && !channel) {
    try {
      const existingChannel =
        client.channels.cache.get(panel.channelId) || (await client.channels.fetch(panel.channelId).catch(() => null));
      if (existingChannel?.isTextBased()) {
        const existingMessage = await existingChannel.messages.fetch(panel.messageId).catch(() => null);
        if (existingMessage) {
          await existingMessage.edit(payload);
          return { updated: true, message: existingMessage };
        }
      }
    } catch (err) {
      console.error('[rolePanelService] Failed to edit existing panel, will repost:', err.message);
    }
  }

  const targetChannel = channel || client.channels.cache.get(panel.channelId);
  if (!targetChannel) throw new Error('No channel to post in — pass one to /role-panel repost.');

  const message = await targetChannel.send(payload);
  await prisma.rolePanel.update({
    where: { id: panel.id },
    data: { channelId: targetChannel.id, messageId: message.id },
  });
  return { updated: false, message };
}

/**
 * Returns the subset of a panel's buttons whose configured role no
 * longer exists in the guild — used to warn an admin in /role-panel
 * edit/list rather than letting a stale role silently fail on click.
 */
async function findMissingRoles(guild, panel) {
  const missing = [];
  for (const b of panel.buttons) {
    const role = guild.roles.cache.get(b.roleId) || (await guild.roles.fetch(b.roleId).catch(() => null));
    if (!role) missing.push(b);
  }
  return missing;
}

/**
 * Handles a member clicking a Role Panel button: toggles the role off
 * if they already have it, otherwise enforces exclusivity within the
 * panel (removes any other role from the same panel, then adds the
 * clicked one) and logs the change. A defensive reconciliation pass
 * at the end collapses state to a single role even if two clicks landed
 * near-simultaneously.
 */
async function handleRolePanelClick(client, interaction, panelId, buttonId) {
  const panel = await prisma.rolePanel.findUnique({ where: { id: panelId }, include: { buttons: true } });
  if (!panel) return { result: 'panel_missing' };

  const clicked = panel.buttons.find((b) => b.id === buttonId);
  if (!clicked) return { result: 'button_missing' };

  const guild = interaction.guild;
  const role = guild.roles.cache.get(clicked.roleId) || (await guild.roles.fetch(clicked.roleId).catch(() => null));
  if (!role) {
    await logToGuild(
      client,
      guild.id,
      '⚠️ Role Panel Button Broken',
      `Panel: ${panel.title}\nButton: ${clicked.label}\nConfigured role \`${clicked.roleId}\` no longer exists. Edit the panel to fix it.`
    );
    return { result: 'role_missing' };
  }

  const member = interaction.member;
  const panelRoleIds = panel.buttons.map((b) => b.roleId);
  const hasClickedRole = member.roles.cache.has(clicked.roleId);

  let added = null;
  let removed = null;

  if (hasClickedRole) {
    await member.roles.remove(clicked.roleId, `Role Panel: ${panel.title} — deselected`).catch(() => {});
    removed = role.name;
  } else {
    const otherHeldRoleIds = panelRoleIds.filter((id) => id !== clicked.roleId && member.roles.cache.has(id));
    for (const id of otherHeldRoleIds) {
      await member.roles.remove(id, `Role Panel: ${panel.title} — switched selection`).catch(() => {});
    }

    try {
      await member.roles.add(clicked.roleId, `Role Panel: ${panel.title} — selected`);
    } catch (err) {
      console.error('[rolePanelService] Role assignment failed:', err.message);
      await logToGuild(
        client,
        guild.id,
        '⚠️ Role Panel Assignment Failed',
        `Panel: ${panel.title}\nButton: ${clicked.label}\nCouldn\u2019t assign \`${role.name}\` to <@${interaction.user.id}> — likely a role hierarchy issue (the bot's role must sit above it).`
      );
      return { result: 'role_assign_failed' };
    }

    added = role.name;
    if (otherHeldRoleIds.length) {
      removed = panel.buttons.find((b) => b.roleId === otherHeldRoleIds[0])?.roleName || null;
    }

    // Defensive reconciliation against a near-simultaneous second click
    // landing while the above awaits were in flight.
    const freshMember = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (freshMember) {
      const stillExtra = panelRoleIds.filter((id) => id !== clicked.roleId && freshMember.roles.cache.has(id));
      for (const id of stillExtra) {
        await freshMember.roles.remove(id, `Role Panel: ${panel.title} — exclusivity cleanup`).catch(() => {});
      }
    }
  }

  await logToGuild(
    client,
    guild.id,
    '🎛️ Role Panel Selection',
    `User: <@${interaction.user.id}>\nPanel: ${panel.title}\n` +
      `${removed ? `Removed: ${removed}\n` : ''}${added ? `Added: ${added}\n` : ''}` +
      `Time: ${new Date().toUTCString()}`
  );

  return { result: hasClickedRole ? 'removed' : 'added', roleName: role.name };
}

module.exports = { postOrUpdatePanel, findMissingRoles, handleRolePanelClick };
