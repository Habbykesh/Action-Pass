const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('./config');

// Only these two are registered GLOBALLY (visible in every server the
// bot is in) — they're the only things a partner server ever needs.
// Every other command is registered as a guild command scoped to
// Action Model only, so Discord itself won't show them anywhere else.
// This is the actual enforcement; the runtime check in
// interactionCreate.js is just a defense-in-depth backstop.
const GLOBAL_COMMAND_NAMES = new Set(['link-username', 'campaign-repost']);

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

const allCommands = commandFiles.map((file) => require(path.join(commandsPath, file)).data.toJSON());

const globalCommands = allCommands.filter((c) => GLOBAL_COMMAND_NAMES.has(c.name));
const guildCommands = allCommands.filter((c) => !GLOBAL_COMMAND_NAMES.has(c.name));

const rest = new REST().setToken(config.token);

(async () => {
  try {
    console.log(`Registering ${globalCommands.length} global command(s): ${globalCommands.map((c) => c.name).join(', ')}`);
    await rest.put(Routes.applicationCommands(config.clientId), { body: globalCommands });

    console.log(
      `Registering ${guildCommands.length} Action Model-only command(s) in guild ${config.actionModelGuildId}: ${guildCommands
        .map((c) => c.name)
        .join(', ')}`
    );
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.actionModelGuildId), { body: guildCommands });

    console.log(
      'Done. Guild commands (Action Model) are live immediately. Global commands (link-username, campaign-repost) can take up to an hour to propagate everywhere else.'
    );
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
