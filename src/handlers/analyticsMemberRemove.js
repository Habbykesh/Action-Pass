const { collector } = require('../services/analytics/collector');

// Separate from guildMemberRemove.js (campaign verification) on purpose:
// each handler file registers its own listener, so neither can break
// the other.
module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    try {
      await collector.recordMemberLeave(member);
    } catch (err) {
      console.error('[analytics] recordMemberLeave failed:', err.message);
    }
  },
};
