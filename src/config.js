require('dotenv').config();

function requireEnv(name) {
  const val = process.env[name];
  if (!val || !val.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return val.trim();
}

const config = {
  token: requireEnv('DISCORD_TOKEN'),
  clientId: requireEnv('DISCORD_CLIENT_ID'),
  databaseUrl: requireEnv('DATABASE_URL'),
  ownerIds: (process.env.OWNER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  homeGuildId: requireEnv('HOME_GUILD_ID'),
  recheckIntervalMinutes: Number(process.env.RECHECK_INTERVAL_MINUTES || 60),

  // The Action Model server. The Alpha/Code Gate and Visual Verification
  // Gate are exclusive to this one guild — every command and component
  // handler for those features checks against this ID at runtime, since
  // slash commands are registered globally and default member
  // permissions alone don't restrict a command to a single server.
  actionModelGuildId: requireEnv('ACTION_MODEL_GUILD_ID'),

  // Server & Member Analytics. Every value is optional; the defaults
  // are what ships.
  analytics: {
    // Longest reporting period a command may request.
    maxPeriodDays: Number(process.env.ANALYTICS_MAX_PERIOD_DAYS || 730),

    // How often in-memory counters are written to Postgres.
    flushIntervalSeconds: Number(process.env.ANALYTICS_FLUSH_INTERVAL_SECONDS || 30),

    // Backfill: each reaction emoji on a historical message costs one API
    // call to learn who reacted. This caps those calls per backfill run.
    backfillMaxReactionFetches: Number(process.env.ANALYTICS_BACKFILL_MAX_REACTION_FETCHES || 5000),

    leaderboardDefaultDays: 30,
    leaderboardSize: 10,

    // Transparent activity score:
    //   score = messages × 1 + reactions × 0.5 + voiceMinutes × 0.2
    weights: { message: 1, reaction: 0.5, voiceMinute: 0.2 },

    // Guilds that get tracking switched on automatically the first time
    // the bot starts with this feature (only if they have no analytics
    // config yet, so `!analytics disable` is never overridden).
    autoEnableGuildIds: [
      process.env.HOME_GUILD_ID?.trim(),
      process.env.ACTION_MODEL_GUILD_ID?.trim(),
    ].filter(Boolean),
  },
};

if (config.ownerIds.length === 0) {
  throw new Error('OWNER_IDS must contain at least one Discord user ID.');
}

module.exports = config;
