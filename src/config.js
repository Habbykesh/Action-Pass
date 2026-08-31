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
};

if (config.ownerIds.length === 0) {
  throw new Error('OWNER_IDS must contain at least one Discord user ID.');
}

module.exports = config;
