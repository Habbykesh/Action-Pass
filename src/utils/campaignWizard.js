// Campaign creation involves more steps than a single slash command or
// modal can hold (arbitrary number of servers, role choice, dates), so
// we track an in-memory draft per user while they click through the
// wizard buttons/modals. Drafts expire after 15 minutes of inactivity.

const drafts = new Map();
const DRAFT_TTL_MS = 15 * 60 * 1000;

function key(userId, guildId) {
  return `${guildId}:${userId}`;
}

function startDraft(userId, guildId, name) {
  const draft = {
    name,
    ownerGuildId: guildId,
    createdByUserId: userId,
    requiredServers: [],
    roleServerId: null,
    existingRoleId: null,
    startAt: null,
    deadlineAt: null,
    updatedAt: Date.now(),
  };
  drafts.set(key(userId, guildId), draft);
  return draft;
}

function getDraft(userId, guildId) {
  const draft = drafts.get(key(userId, guildId));
  if (!draft) return null;
  if (Date.now() - draft.updatedAt > DRAFT_TTL_MS) {
    drafts.delete(key(userId, guildId));
    return null;
  }
  return draft;
}

function touchDraft(userId, guildId) {
  const draft = getDraft(userId, guildId);
  if (draft) draft.updatedAt = Date.now();
  return draft;
}

function clearDraft(userId, guildId) {
  drafts.delete(key(userId, guildId));
}

module.exports = { startDraft, getDraft, touchDraft, clearDraft };
