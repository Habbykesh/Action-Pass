const { handleMemberLeftGuild } = require('../services/verificationService');

module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    try {
      await handleMemberLeftGuild(member.client, member.guild.id, member.id);
    } catch (err) {
      console.error('[guildMemberRemove]', err);
    }
  },
};
