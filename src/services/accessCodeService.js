const { prisma } = require('../database/connect');

const CODE_CHARSET = '0123456789';
const CODE_DIGITS = 4;

function randomSuffix() {
  let out = '';
  for (let i = 0; i < CODE_DIGITS; i++) {
    out += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
  }
  return out;
}

/**
 * Generates `amount` unique, short, human-friendly codes like
 * PASS-4827. Uniqueness is enforced both in-memory during generation
 * and by the database's unique constraint on codeUpper — if a
 * collision with an existing DB row slips through, that single insert
 * is retried with a fresh suffix rather than failing the whole batch.
 */
async function generateCodes({ guildId, amount, roleId, roleName, createdByUserId }) {
  const created = [];
  const seenThisBatch = new Set();

  for (let i = 0; i < amount; i++) {
    let code;
    let attempts = 0;
    // Practically this loop runs once almost every time — collisions
    // across a 10,000-value space are rare — but we guard against them
    // rather than assume they can't happen.
    while (true) {
      attempts += 1;
      const candidate = `PASS-${randomSuffix()}`;
      const candidateUpper = candidate.toUpperCase();
      if (seenThisBatch.has(candidateUpper)) {
        if (attempts > 500) throw new Error('Ran out of unique codes to generate — try a smaller amount.');
        continue;
      }
      const existing = await prisma.accessCode.findUnique({ where: { codeUpper: candidateUpper } });
      if (existing) {
        if (attempts > 500) throw new Error('Ran out of unique codes to generate — try a smaller amount.');
        continue;
      }
      code = candidate;
      break;
    }

    seenThisBatch.add(code.toUpperCase());
    const row = await prisma.accessCode.create({
      data: {
        guildId,
        code,
        codeUpper: code.toUpperCase(),
        roleId,
        roleName,
        createdByUserId,
      },
    });
    created.push(row);
  }

  return created;
}

/**
 * Atomically redeems a code: the conditional UPDATE (code + used:false
 * in the WHERE clause) is what actually prevents two simultaneous
 * redemptions of the same code — Postgres serializes concurrent
 * updates to the same row, so only the first one can match `used:
 * false` and flip it. The second gets `count: 0` back.
 */
async function redeemCode({ guildId, code, userId, username }) {
  const codeUpper = code.trim().toUpperCase();

  const existing = await prisma.accessCode.findUnique({ where: { codeUpper } });
  if (!existing || existing.guildId !== guildId) {
    return { ok: false, reason: 'not_found' };
  }
  if (existing.used) {
    return { ok: false, reason: 'already_used' };
  }

  const result = await prisma.accessCode.updateMany({
    where: { codeUpper, used: false },
    data: { used: true, usedByUserId: userId, usedByName: username, usedAt: new Date() },
  });

  if (result.count === 0) {
    // Someone else redeemed it in the gap between our read and our write.
    return { ok: false, reason: 'already_used' };
  }

  return { ok: true, code: existing };
}

/**
 * Reverts a code back to unused — used only when role assignment fails
 * right after a successful redemption, so the code isn't burned for
 * nothing.
 */
async function releaseCode(codeId) {
  await prisma.accessCode.update({
    where: { id: codeId },
    data: { used: false, usedByUserId: null, usedByName: null, usedAt: null },
  });
}

async function getStats(guildId) {
  const [total, used] = await Promise.all([
    prisma.accessCode.count({ where: { guildId } }),
    prisma.accessCode.count({ where: { guildId, used: true } }),
  ]);
  return { total, used, unused: total - used };
}

module.exports = { generateCodes, redeemCode, releaseCode, getStats };
