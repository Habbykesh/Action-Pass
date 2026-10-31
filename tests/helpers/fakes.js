// Minimal stand-ins for the discord.js objects the analytics code touches.
const { PermissionFlagsBits } = require('discord.js');

function fakeUser(id, username, bot = false) {
  return { id, username, bot, avatarURL: null };
}

function fakeMember(id, username, { bot = false, admin = false } = {}) {
  return {
    id,
    displayName: username,
    user: fakeUser(id, username, bot),
    displayAvatarURL: () => null,
    permissions: { has: (flag) => admin && flag === PermissionFlagsBits.Administrator },
  };
}

function fakeGuild(id, name, members = []) {
  const cache = new Map(members.map((m) => [m.id, m]));
  return {
    id,
    name,
    memberCount: members.length,
    available: true,
    features: ['COMMUNITY'],
    verificationLevel: 2,
    premiumTier: 1,
    premiumSubscriptionCount: 3,
    createdAt: new Date('2022-01-01T00:00:00Z'),
    afkChannelId: 'afk-1',
    iconURL: () => null,
    channels: { cache: new Map() },
    roles: { cache: { size: 5 } },
    members: {
      cache,
      me: { id: 'bot' },
      async fetch(arg) {
        if (typeof arg === 'string') {
          const m = cache.get(arg);
          if (!m) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
          return m;
        }
        return cache;
      },
    },
    voiceStates: { cache: new Map() },
  };
}

function fakeMessage({ guild, author, content, perms = null, isOwnerPerms }) {
  const replies = [];
  const authorMember = guild.members.cache.get(author.id) || fakeMember(author.id, author.username, { admin: false });
  guild.members.me = { id: 'bot' };
  const msg = {
    id: String(Math.random()).slice(2),
    guild,
    guildId: guild.id,
    channelId: 'chan-1',
    author,
    member: authorMember,
    content,
    channel: {
      sendTyping: async () => {},
      permissionsFor: () => perms || { has: () => true },
    },
    replies,
    async reply(payload) {
      replies.push(payload);
      payload.edits = [];
      payload.edit = async (p) => { payload.edits.push(p); };
      return payload;
    },
  };
  return msg;
}

let iseq = 0;
/**
 * Fake chat-input interaction for /analytics.
 * opts: { sub, amount, unit, user, private }
 */
function fakeInteraction({ guild, member, sub, opts = {}, owner = false }) {
  const calls = [];
  const i = {
    id: `i${iseq++}`,
    guild,
    guildId: guild.id,
    user: owner ? { id: process.env.OWNER_IDS.split(',')[0], bot: false } : { id: member.id + '-' + iseq, bot: false },
    member,
    memberPermissions: member.permissions,
    channel: { send: async (p) => { calls.push({ kind: 'channel.send', p }); return { edit: async (q) => { calls.push({ kind: 'fallback.edit', p: q }); } }; } },
    deferred: false,
    replied: false,
    calls,
    inGuild: () => true,
    options: {
      getSubcommand: () => sub,
      getInteger: (n) => opts[n] ?? null,
      getString: (n) => opts[n] ?? null,
      getUser: (n) => opts[n] ?? null,
      getBoolean: (n) => opts[n] ?? null,
    },
    async reply(p) { i.replied = true; calls.push({ kind: 'reply', p }); },
    async deferReply(p) { i.deferred = true; calls.push({ kind: 'defer', p }); },
    async editReply(p) { calls.push({ kind: 'edit', p }); return {}; },
    async followUp(p) { calls.push({ kind: 'followUp', p }); return {}; },
  };
  // convenience views
  i.edits = () => calls.filter((c) => c.kind === 'edit').map((c) => c.p);
  i.first = () => (calls.find((c) => c.kind === 'edit') || calls.find((c) => c.kind === 'reply'))?.p;
  i.last = () => calls.filter((c) => c.kind === 'edit').at(-1)?.p;
  return i;
}

module.exports = { fakeUser, fakeMember, fakeGuild, fakeMessage, fakeInteraction };
