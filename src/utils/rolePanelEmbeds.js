const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const COLOR = 0x5865f2;
const COLOR_SUCCESS = 0x57f287;
const COLOR_FAIL = 0xed4245;
const BRAND_FOOTER = 'ActionFi Partnerships';

const VALID_STYLES = ['Primary', 'Secondary', 'Success', 'Danger'];
const STYLE_MAP = {
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
  Danger: ButtonStyle.Danger,
};

function normalizeStyle(raw) {
  const match = VALID_STYLES.find((s) => s.toLowerCase() === String(raw).trim().toLowerCase());
  return match || null;
}

// ── Admin wizard (create/edit) ──────────────────────────────────────

function rolePanelWizardEmbed(draft) {
  const buttonLines = draft.buttons.length
    ? draft.buttons
        .map((b, i) => `${i + 1}. ${b.emoji ? `${b.emoji} ` : ''}**${b.label}** → ${b.roleName} (${b.style})`)
        .join('\n')
    : '_No buttons added yet — add at least 1._';

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`🎛️  ${draft.editingPanelId ? 'Editing' : 'Draft'} Role Panel: ${draft.internalName}`)
    .addFields(
      { name: 'Title', value: draft.title || '_Not set yet._' },
      { name: 'Description', value: draft.description || '_Not set yet._' },
      { name: `Buttons (${draft.buttons.length}/25)`, value: buttonLines }
    )
    .setFooter({ text: 'Use the buttons below, then Save. Post it with /role-panel repost.' });
}

function rolePanelWizardRows(draft) {
  const canSave = Boolean(draft.title) && Boolean(draft.description) && draft.buttons.length >= 1;
  const hasButtons = draft.buttons.length > 0;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rpwizard_set_info').setLabel('Set Info').setEmoji('📝').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('rpwizard_add_button')
      .setLabel('Add Button')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(draft.buttons.length >= 25),
    new ButtonBuilder()
      .setCustomId('rpwizard_edit_button')
      .setLabel('Edit Button')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasButtons),
    new ButtonBuilder()
      .setCustomId('rpwizard_remove_button')
      .setLabel('Remove Button')
      .setEmoji('➖')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasButtons)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('rpwizard_save')
      .setLabel(draft.editingPanelId ? 'Save Changes' : 'Create Panel')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canSave),
    new ButtonBuilder().setCustomId('rpwizard_cancel').setLabel('Cancel').setEmoji('✖').setStyle(ButtonStyle.Danger)
  );
  return [row1, row2];
}

// ── Button picker (used by both Edit Button and Remove Button) ─────

function buttonPickerRow(customId, draft, placeholder) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(
      draft.buttons.map((b, i) => ({
        label: `${i + 1}. ${b.label}`.slice(0, 100),
        description: `Role: ${b.roleName} (${b.style})`.slice(0, 100),
        value: String(i),
      }))
    );
  return [new ActionRowBuilder().addComponents(select), backRow()];
}

function backRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rpwizard_back').setLabel('◀ Back').setStyle(ButtonStyle.Secondary)
  );
}

// ── Add/Edit button sub-flow: info modal → role select → style select ─

function buttonInfoModal(existing = null) {
  const modal = new ModalBuilder()
    .setCustomId('rpwizard_modal_button_info')
    .setTitle(existing ? 'Edit Button' : 'Add Button');
  const labelInput = new TextInputBuilder()
    .setCustomId('label')
    .setLabel('Button label')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);
  const emojiInput = new TextInputBuilder()
    .setCustomId('emoji')
    .setLabel('Emoji (optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(10);
  if (existing?.label) labelInput.setValue(existing.label);
  if (existing?.emoji) emojiInput.setValue(existing.emoji);
  modal.addComponents(
    new ActionRowBuilder().addComponents(labelInput),
    new ActionRowBuilder().addComponents(emojiInput)
  );
  return modal;
}

function roleSelectPromptRows() {
  const select = new RoleSelectMenuBuilder()
    .setCustomId('rpwizard_button_role_select')
    .setPlaceholder('Search and select the role for this button')
    .setMinValues(1)
    .setMaxValues(1);
  return [new ActionRowBuilder().addComponents(select), backRow()];
}

function styleSelectPromptRows() {
  const select = new StringSelectMenuBuilder()
    .setCustomId('rpwizard_button_style_select')
    .setPlaceholder('Pick a button style')
    .addOptions(VALID_STYLES.map((s) => ({ label: s, value: s })));
  return [new ActionRowBuilder().addComponents(select), backRow()];
}

function pendingButtonStepEmbed(step, pending) {
  const lines = [];
  if (pending.label) lines.push(`Label: **${pending.emoji ? `${pending.emoji} ` : ''}${pending.label}**`);
  if (pending.roleName) lines.push(`Role: **${pending.roleName}**`);

  const stepText = { role: 'Now pick the role.', style: 'Now pick the button style.' }[step];

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(pending.editIndex != null ? '✏️  Editing Button' : '➕  Adding Button')
    .setDescription([...lines, '', stepText].filter(Boolean).join('\n'));
}

function infoModal(draft) {
  const modal = new ModalBuilder().setCustomId('rpwizard_modal_info').setTitle('Panel Info');
  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Title')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(256);
  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);
  if (draft.title) titleInput.setValue(draft.title);
  if (draft.description) descInput.setValue(draft.description);
  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(descInput)
  );
  return modal;
}



// ── Posted panel (member-facing) ────────────────────────────────────

function rolePanelPostEmbed(panel) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(panel.title)
    .setDescription(panel.description)
    .setFooter({ text: BRAND_FOOTER });
}

function rolePanelPostRows(panel) {
  const rows = [];
  for (let i = 0; i < panel.buttons.length; i += 5) {
    const slice = panel.buttons.slice(i, i + 5);
    rows.push(
      new ActionRowBuilder().addComponents(
        slice.map((b) => {
          const btn = new ButtonBuilder()
            .setCustomId(`rolepanel_${panel.id}_${b.id}`)
            .setLabel(b.label)
            .setStyle(STYLE_MAP[b.style] || ButtonStyle.Secondary);
          if (b.emoji) btn.setEmoji(b.emoji);
          return btn;
        })
      )
    );
  }
  return rows;
}

function roleMissingEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_FAIL)
    .setTitle('⚠️  Button Unavailable')
    .setDescription('This button\u2019s role no longer exists. An admin has been notified in the log channel.')
    .setFooter({ text: BRAND_FOOTER });
}

function roleSelectionEmbed(result, roleName) {
  if (result === 'added') {
    return new EmbedBuilder().setColor(COLOR_SUCCESS).setDescription(`✅ You\u2019ve been given **${roleName}**.`);
  }
  return new EmbedBuilder().setColor(COLOR_SUCCESS).setDescription(`↩️ **${roleName}** removed.`);
}

module.exports = {
  VALID_STYLES,
  normalizeStyle,
  rolePanelWizardEmbed,
  rolePanelWizardRows,
  infoModal,
  buttonPickerRow,
  backRow,
  buttonInfoModal,
  roleSelectPromptRows,
  styleSelectPromptRows,
  pendingButtonStepEmbed,
  rolePanelPostEmbed,
  rolePanelPostRows,
  roleMissingEmbed,
  roleSelectionEmbed,
};
