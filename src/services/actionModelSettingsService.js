const { prisma } = require('../database/connect');
const config = require('../config');

async function getSettings() {
  const settings = await prisma.actionModelSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, guildId: config.actionModelGuildId },
  });
  return settings;
}

async function updateSettings(data) {
  return prisma.actionModelSettings.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, guildId: config.actionModelGuildId, ...data },
  });
}

/**
 * Posts the verification panel if none exists yet for this guild, or
 * edits the existing one in place — so changing wording, the image, a
 * button label, or a role through /setup never spawns a second panel
 * message.
 */
async function postOrUpdatePanel(client, settings, channel) {
  const { panelEmbed, panelRows } = require('../utils/actionModelEmbeds');
  const payload = { embeds: [panelEmbed(settings)], components: panelRows(settings) };

  if (settings.panelChannelId && settings.panelMessageId) {
    try {
      const existingChannel =
        client.channels.cache.get(settings.panelChannelId) ||
        (await client.channels.fetch(settings.panelChannelId).catch(() => null));
      if (existingChannel?.isTextBased()) {
        const existingMessage = await existingChannel.messages.fetch(settings.panelMessageId).catch(() => null);
        if (existingMessage) {
          await existingMessage.edit(payload);
          return { updated: true, message: existingMessage };
        }
      }
    } catch (err) {
      console.error('[actionModelSettingsService] Failed to edit existing panel, will repost:', err.message);
    }
  }

  const message = await channel.send(payload);
  await updateSettings({ panelChannelId: channel.id, panelMessageId: message.id });
  return { updated: false, message };
}

module.exports = { getSettings, updateSettings, postOrUpdatePanel };
