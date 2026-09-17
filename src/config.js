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
};

if (config.ownerIds.length === 0) {
  throw new Error('OWNER_IDS must contain at least one Discord user ID.');
}

module.exports = config;
