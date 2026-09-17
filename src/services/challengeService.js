// Active visual-verification challenges, one per user per guild. Kept
// in memory (mirroring the existing campaignWizard draft pattern) since
// a challenge only needs to survive the few seconds between the user
// seeing the image and answering it — it's never looked up outside a
// live interaction, so it doesn't need a database row. The correct
// answer lives only here, never in anything sent to the client.

const { renderText, renderObject, OBJECT_NAMES } = require('./challengeImageService');

const challenges = new Map();
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

const CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — avoids ambiguity

function key(userId, guildId) {
  return `${guildId}:${userId}`;
}

function randomFrom(charset, length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += charset[Math.floor(Math.random() * charset.length)];
  }
  return out;
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildLetterChallenge() {
  const answer = randomFrom(CODE_CHARSET, 6);
  const decoys = new Set();
  while (decoys.size < 3) {
    const candidate = randomFrom(CODE_CHARSET, 6);
    if (candidate !== answer) decoys.add(candidate);
  }
  const options = shuffle([answer, ...decoys]);
  return {
    type: 'letters',
    answer,
    options,
    image: renderText(answer),
  };
}

function buildNumberChallenge() {
  const answer = String(randomFrom('0123456789', 6));
  return {
    type: 'number',
    answer,
    options: null,
    image: renderText(answer),
  };
}

function buildObjectChallenge() {
  const answer = OBJECT_NAMES[Math.floor(Math.random() * OBJECT_NAMES.length)];
  const decoys = new Set();
  while (decoys.size < 3) {
    const candidate = OBJECT_NAMES[Math.floor(Math.random() * OBJECT_NAMES.length)];
    if (candidate !== answer) decoys.add(candidate);
  }
  const options = shuffle([answer, ...decoys]);
  return {
    type: 'object',
    answer,
    options,
    image: renderObject(answer),
  };
}

const BUILDERS = [buildLetterChallenge, buildNumberChallenge, buildObjectChallenge];

/**
 * Generates a brand-new challenge (randomly one of the 3 types) and
 * stores it as this user's active challenge, replacing any previous
 * one — used both for the first attempt and every retry after a wrong
 * answer, so a wrong guess never lets someone see the same challenge
 * again.
 */
function generateChallenge(userId, guildId) {
  const builder = BUILDERS[Math.floor(Math.random() * BUILDERS.length)];
  const challenge = { ...builder(), createdAt: Date.now() };
  challenges.set(key(userId, guildId), challenge);
  return challenge;
}

function getActiveChallenge(userId, guildId) {
  const challenge = challenges.get(key(userId, guildId));
  if (!challenge) return null;
  if (Date.now() - challenge.createdAt > CHALLENGE_TTL_MS) {
    challenges.delete(key(userId, guildId));
    return null;
  }
  return challenge;
}

function clearChallenge(userId, guildId) {
  challenges.delete(key(userId, guildId));
}

/**
 * Compares a submitted answer against the stored challenge, case- and
 * whitespace-insensitive.
 */
function checkAnswer(challenge, submitted) {
  if (!challenge || submitted == null) return false;
  return String(submitted).trim().toLowerCase() === String(challenge.answer).trim().toLowerCase();
}

module.exports = {
  generateChallenge,
  getActiveChallenge,
  clearChallenge,
  checkAnswer,
};
