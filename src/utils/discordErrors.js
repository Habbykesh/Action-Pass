/**
 * True when Discord rejected the gateway login because a privileged
 * intent isn't enabled in the Developer Portal. @discordjs/ws surfaces
 * this as a plain Error("Used disallowed intents") (close code 4014);
 * older/newer versions may instead carry code "DisallowedIntents" or
 * the message "Privileged intent provided is not enabled or whitelisted."
 */
function isDisallowedIntentsError(err) {
  if (!err) return false;
  if (err.code === 'DisallowedIntents' || err.code === 4014) return true;
  return /disallowed intents|privileged intent/i.test(String(err.message || ''));
}

module.exports = { isDisallowedIntentsError };
