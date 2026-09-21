// Role Panel creation/editing involves more steps than a single slash
// command or modal can hold (arbitrary number of buttons), so we track
// an in-memory draft per user while they click through the wizard —
// same pattern as campaignWizard.js. Drafts expire after 15 minutes of
// inactivity.

const drafts = new Map();
const DRAFT_TTL_MS = 15 * 60 * 1000;

function key(userId, guildId) {
  return `${guildId}:${userId}`;
}

/**
 * Starts a fresh draft, or — if existingPanel is passed — pre-fills it
 * from an existing panel for /role-panel edit.
 */
function startDraft(userId, guildId, internalName, existingPanel = null) {
  const draft = {
    internalName,
    guildId,
    createdByUserId: userId,
    editingPanelId: existingPanel?.id || null,
    title: existingPanel?.title || null,
    description: existingPanel?.description || null,
    buttons: existingPanel
      ? [...existingPanel.buttons]
          .sort((a, b) => a.position - b.position)
          .map((b) => ({ label: b.label, emoji: b.emoji, style: b.style, roleId: b.roleId, roleName: b.roleName }))
      : [],
    // Holds { label, emoji, roleId, roleName, editIndex } while the
    // user is mid-way through the Add/Edit Button sub-flow (info modal
    // → role select → style select). editIndex is null when adding a
    // new button, or the index being replaced when editing one.
    pendingButton: null,
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
