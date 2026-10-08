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
  client.on(handler.name, async (...args) => {
    try {
      await handler.execute(...args);
    } catch (err) {
      // One failed interaction/event must never take the whole bot down.
      console.error(`[${handler.name}] Unhandled handler error:`, err);

      const interaction = args[0];
      // 10062 = the interaction token already expired, so there's
      // nothing left to reply to.
      if (handler.name === 'interactionCreate' && err?.code !== 10062 && interaction?.isRepliable?.()) {
        const payload = { content: '⚠️ Something went wrong. Please try again.', ephemeral: true };
        try {
          if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
          else await interaction.reply(payload);
        } catch (replyErr) {
          console.error('[interactionCreate] Could not send error reply:', replyErr.message);
        }
      }
    }
  });
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

process.on('unhandledRejection', (err) => {
  console.error('[process] Unhandled rejection:', err);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  client.destroy();
  process.exit(0);
});
