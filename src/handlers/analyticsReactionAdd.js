const { collector } = require('../services/analytics/collector');

module.exports = {
  name: 'messageReactionAdd',
  async execute(reaction, user) {
    collector.recordReaction(reaction, user);
  },
};
