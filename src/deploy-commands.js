const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('./config');

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

const commands = commandFiles.map((file) => require(path.join(commandsPath, file)).data.toJSON());

const rest = new REST().setToken(config.token);

(async () => {
  try {
    console.log(`Registering ${commands.length} global application command(s)...`);
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('Done. Global commands can take up to an hour to propagate to all servers.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
