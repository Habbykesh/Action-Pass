const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const config = require('./config');
const { connectDatabase, prisma } = require('./database/connect');
const { recheckCampaign } = require('./services/verificationService');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember],
});

client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

const handlersPath = path.join(__dirname, 'handlers');
for (const file of fs.readdirSync(handlersPath).filter((f) => f.endsWith('.js'))) {
  const handler = require(path.join(handlersPath, file));
  client.on(handler.name, (...args) => handler.execute(...args));
}

async function runPeriodicRecheck() {
  try {
    const activeCampaigns = await prisma.campaign.findMany({
      where: { status: 'active' },
      include: { requiredServers: true },
    });
    for (const campaign of activeCampaigns) {
      await recheckCampaign(client, campaign);
    }
  } catch (err) {
    console.error('[periodicRecheck]', err);
  }
}

client.once('clientReady', () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  const intervalMs = config.recheckIntervalMinutes * 60 * 1000;
  setInterval(runPeriodicRecheck, intervalMs);
});

async function main() {
  await connectDatabase();
  await client.login(config.token);
}

main().catch((err) => {
  console.error('[bot] Fatal startup error:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  client.destroy();
  process.exit(0);
});
