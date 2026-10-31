const { collector } = require('../services/analytics/collector');

// Server & Member Analytics: counts the message (synchronous, in-memory).
// Only message METADATA is used (author, guild, timestamp) — no message
// content, so no privileged Message Content intent is required.
module.exports = {
  name: 'messageCreate',
  async execute(message) {
    try {
      collector.recordMessage(message);
    } catch (err) {
      console.error('[analytics] recordMessage failed:', err.message);
    }
  },
};
