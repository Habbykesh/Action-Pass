const { collector } = require('../services/analytics/collector');

// Loads per-guild settings, resumes/closes voice sessions left over from
// the previous run and starts the periodic flush.
module.exports = {
  name: 'clientReady',
  async execute(client) {
    await collector.init(client);
    console.log('[analytics] Collector ready.');
  },
};
