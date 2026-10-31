const { collector } = require('../services/analytics/collector');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    try {
      await collector.recordMemberJoin(member);
    } catch (err) {
      console.error('[analytics] recordMemberJoin failed:', err.message);
    }
  },
};
