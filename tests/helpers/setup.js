// Test bootstrap: fake env, and a Prisma stand-in backed by a real
// Postgres (via `pg`) when TEST_DATABASE_URL is set. The analytics code
// only uses $queryRaw / $executeRaw tagged templates, which this shim
// reproduces faithfully ($1, $2… parameters).

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '111111111111111111';
process.env.DATABASE_URL ||= 'postgresql://unused';
process.env.OWNER_IDS ||= '999999999999999999';
process.env.HOME_GUILD_ID ||= '100000000000000001';
process.env.ACTION_MODEL_GUILD_ID ||= '100000000000000002';

const fs = require('fs');
const path = require('path');

let pool = null;
function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  }
  return pool;
}

function build(strings, values) {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
  return { text, values };
}

const shim = {
  async $queryRaw(strings, ...values) {
    const { text, values: v } = build(strings, values);
    return (await getPool().query(text, v)).rows;
  },
  async $executeRaw(strings, ...values) {
    const { text, values: v } = build(strings, values);
    return (await getPool().query(text, v)).rowCount;
  },
};

// Make `require('../database/connect')` return the shim instead of a
// real PrismaClient (which can't be generated in every environment).
const connectPath = require.resolve('../../src/database/connect');
require.cache[connectPath] = {
  id: connectPath,
  filename: connectPath,
  loaded: true,
  exports: { prisma: shim, connectDatabase: async () => {} },
};

async function resetDb() {
  const p = getPool();
  await p.query('DROP TABLE IF EXISTS "ActivityHourly","ActivityMemberEvent","ActivityVoiceSession","GuildAnalyticsConfig" CASCADE');
  const dir = path.join(__dirname, '..', '..', 'prisma', 'migrations');
  for (const name of ['20261030120000_add_server_analytics', '20261031120000_analytics_backfill']) {
    await p.query(fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8'));
  }
}

async function closeDb() {
  if (pool) await pool.end();
  pool = null;
}

const silentLogger = { error() {}, warn() {}, log() {} };

module.exports = { shim, resetDb, closeDb, getPool, silentLogger, hasDb: Boolean(process.env.TEST_DATABASE_URL) };
