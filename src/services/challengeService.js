// Active human-verification challenges, one per user per guild. Kept in
// memory (mirroring the campaignWizard draft pattern) since a challenge
// only needs to survive the few seconds between the user seeing it and
// answering — it's never looked up outside a live interaction, so it
// doesn't need a database row. The correct answer lives only here,
// never in anything sent to the client.
//
// All three challenge types are text/emoji only — no image generation,
// no canvas, no native image dependency. Discord already renders emoji
// natively, so an emoji-pick challenge looks clean for free.

const challenges = new Map();
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function key(userId, guildId) {
  return `${guildId}:${userId}`;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const EMOJI_POOL = [
  { emoji: '🐶', label: 'dog' },
  { emoji: '🍎', label: 'apple' },
  { emoji: '🚗', label: 'car' },
  { emoji: '🌳', label: 'tree' },
  { emoji: '⭐', label: 'star' },
  { emoji: '☂️', label: 'umbrella' },
  { emoji: '🏠', label: 'house' },
  { emoji: '☕', label: 'cup' },
  { emoji: '🎈', label: 'balloon' },
  { emoji: '🎸', label: 'guitar' },
  { emoji: '🎯', label: 'target' },
  { emoji: '🌙', label: 'moon' },
];

function buildEmojiChallenge() {
  const chosen = shuffle(EMOJI_POOL).slice(0, 4);
  const answerItem = chosen[randInt(0, chosen.length - 1)];
  return {
    type: 'emoji',
    answer: answerItem.emoji,
    promptLabel: answerItem.label,
    options: chosen.map((c) => c.emoji),
  };
}

function buildMathChallenge() {
  const a = randInt(2, 12);
  const b = randInt(2, 12);
  const answer = String(a + b);
  const decoys = new Set();
  while (decoys.size < 3) {
    const offset = randInt(-5, 5);
    if (offset === 0) continue;
    const candidate = String(a + b + offset);
    if (candidate !== answer && Number(candidate) > 0) decoys.add(candidate);
  }
  return {
    type: 'math',
    answer,
    promptLabel: `${a} + ${b}`,
    options: shuffle([answer, ...decoys]),
  };
}

const WORD_LIST = [
  'PURPLE', 'GALAXY', 'ROCKET', 'GARDEN', 'CASTLE', 'WHISPER',
  'LANTERN', 'MARBLE', 'THUNDER', 'VELVET', 'COMPASS', 'HARBOR',
];

function buildWordChallenge() {
  const answer = WORD_LIST[randInt(0, WORD_LIST.length - 1)];
  return {
    type: 'word',
    answer,
    promptLabel: answer,
    options: null,
  };
}

const BUILDERS = [buildEmojiChallenge, buildMathChallenge, buildWordChallenge];

/**
 * Generates a brand-new challenge (randomly one of the 3 types) and
 * stores it as this user's active challenge, replacing any previous
 * one — used both for the first attempt and every retry after a wrong
 * answer, so a wrong guess never lets someone see the same challenge
 * again.
 */
function generateChallenge(userId, guildId) {
  const builder = BUILDERS[randInt(0, BUILDERS.length - 1)];
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
