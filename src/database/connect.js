const { PrismaClient } = require('@prisma/client');

// Reuse a single PrismaClient instance across the app (and across
// hot-reloads in dev) to avoid exhausting Postgres connections.
const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__actionfiPrisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__actionfiPrisma = prisma;
}

async function connectDatabase() {
  await prisma.$connect();
  console.log('[database] Connected to PostgreSQL via Prisma.');

  // Ensure the singleton settings row exists.
  await prisma.botSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
}

module.exports = { prisma, connectDatabase };
