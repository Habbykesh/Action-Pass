const { collector } = require('../services/analytics/collector');

module.exports = {
  name: 'voiceStateUpdate',
  async execute(oldState, newState) {
    collector.onVoiceStateUpdate(oldState, newState);
  },
};
