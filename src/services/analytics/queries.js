// Read side. Every query is scoped by guildId and by an indexed time
// range on the hourly rollup table, so cost is bounded by
// (hours in window × active members), never by raw event volume.
//
// Timestamps cross the boundary as ISO strings cast to `timestamp`
// (the columns are UTC `timestamp(3)`), and come back as ISO text, so
// results never depend on a driver's or server's timezone settings.

const ISO_OUT = `YYYY-MM-DD"T"HH24:MI:SS"Z"`;
const VALID_INTERVALS = new Set(['hour', 'day', 'week']);

function assertInterval(interval) {
  if (!VALID_INTERVALS.has(interval)) throw new Error(`Invalid interval: ${interval}`);
}

function toIso(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

function num(v) {
  return v === null || v === undefined ? 0 : Number(v);
}

/** Server-wide series: per interval, distinct active members + sums. */
async function fetchServerSeries(prisma, guildId, start, end, interval) {
  assertInterval(interval);
  const rows = await prisma.$queryRaw`
    SELECT to_char(date_trunc(${interval}, "bucket"), ${ISO_OUT}) AS ts,
           COUNT(DISTINCT "userId")::float8 AS active,
           COALESCE(SUM("messages"), 0)::float8 AS messages,
           COALESCE(SUM("reactions"), 0)::float8 AS reactions,
           COALESCE(SUM("voiceJoins"), 0)::float8 AS "voiceJoins",
           COALESCE(SUM("voiceSeconds"), 0)::float8 AS "voiceSeconds"
    FROM "ActivityHourly"
    WHERE "guildId" = ${guildId}
      AND "bucket" >= date_trunc('hour', ${toIso(start)}::timestamp)
      AND "bucket" <= ${toIso(end)}::timestamp
    GROUP BY 1
    ORDER BY 1`;
  return rows.map((r) => ({
    ts: r.ts,
    active: num(r.active),
    messages: num(r.messages),
    reactions: num(r.reactions),
    voiceJoins: num(r.voiceJoins),
    voiceSeconds: num(r.voiceSeconds),
  }));
}

/** Server-wide totals + unique active members across the whole window. */
async function fetchServerTotals(prisma, guildId, start, end) {
  const [row] = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT "userId")::float8 AS "activeUsers",
           COALESCE(SUM("messages"), 0)::float8 AS messages,
           COALESCE(SUM("reactions"), 0)::float8 AS reactions,
           COALESCE(SUM("voiceJoins"), 0)::float8 AS "voiceJoins",
           COALESCE(SUM("voiceSeconds"), 0)::float8 AS "voiceSeconds"
    FROM "ActivityHourly"
    WHERE "guildId" = ${guildId}
      AND "bucket" >= date_trunc('hour', ${toIso(start)}::timestamp)
      AND "bucket" <= ${toIso(end)}::timestamp`;
  return {
    activeUsers: num(row?.activeUsers),
    messages: num(row?.messages),
    reactions: num(row?.reactions),
    voiceJoins: num(row?.voiceJoins),
    voiceSeconds: num(row?.voiceSeconds),
  };
}

/** Member joins/leaves per interval (exact event times, not hour-rounded). */
async function fetchMemberEventSeries(prisma, guildId, start, end, interval) {
  assertInterval(interval);
  const rows = await prisma.$queryRaw`
    SELECT to_char(date_trunc(${interval}, "occurredAt"), ${ISO_OUT}) AS ts,
           COUNT(*) FILTER (WHERE "type" = 'join')::float8 AS joins,
           COUNT(*) FILTER (WHERE "type" = 'leave')::float8 AS leaves
    FROM "ActivityMemberEvent"
    WHERE "guildId" = ${guildId}
      AND "occurredAt" >= ${toIso(start)}::timestamp
      AND "occurredAt" <= ${toIso(end)}::timestamp
    GROUP BY 1
    ORDER BY 1`;
  return rows.map((r) => ({ ts: r.ts, joins: num(r.joins), leaves: num(r.leaves) }));
}

/** One member's series. Always filtered by BOTH guildId and userId. */
async function fetchMemberSeries(prisma, guildId, userId, start, end, interval) {
  assertInterval(interval);
  const rows = await prisma.$queryRaw`
    SELECT to_char(date_trunc(${interval}, "bucket"), ${ISO_OUT}) AS ts,
           COALESCE(SUM("messages"), 0)::float8 AS messages,
           COALESCE(SUM("reactions"), 0)::float8 AS reactions,
           COALESCE(SUM("voiceJoins"), 0)::float8 AS "voiceJoins",
           COALESCE(SUM("voiceSeconds"), 0)::float8 AS "voiceSeconds"
    FROM "ActivityHourly"
    WHERE "guildId" = ${guildId}
      AND "userId" = ${userId}
      AND "bucket" >= date_trunc('hour', ${toIso(start)}::timestamp)
      AND "bucket" <= ${toIso(end)}::timestamp
    GROUP BY 1
    ORDER BY 1`;
  return rows.map((r) => ({
    ts: r.ts,
    messages: num(r.messages),
    reactions: num(r.reactions),
    voiceJoins: num(r.voiceJoins),
    voiceSeconds: num(r.voiceSeconds),
  }));
}

/**
 * Top members by activity score. The score is computed in SQL with the
 * same weights the embed displays, so what's shown is what's ranked.
 */
async function fetchLeaderboard(prisma, guildId, start, end, weights, limit) {
  const rows = await prisma.$queryRaw`
    SELECT "userId",
           SUM("messages")::float8 AS messages,
           SUM("reactions")::float8 AS reactions,
           SUM("voiceJoins")::float8 AS "voiceJoins",
           SUM("voiceSeconds")::float8 AS "voiceSeconds",
           (SUM("messages") * ${weights.message}::float8
            + SUM("reactions") * ${weights.reaction}::float8
            + (SUM("voiceSeconds") / 60.0) * ${weights.voiceMinute}::float8)::float8 AS score
    FROM "ActivityHourly"
    WHERE "guildId" = ${guildId}
      AND "bucket" >= date_trunc('hour', ${toIso(start)}::timestamp)
      AND "bucket" <= ${toIso(end)}::timestamp
    GROUP BY "userId"
    HAVING SUM("messages") + SUM("reactions") + SUM("voiceJoins") + SUM("voiceSeconds") > 0
    ORDER BY score DESC, "userId" ASC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    userId: r.userId,
    messages: num(r.messages),
    reactions: num(r.reactions),
    voiceJoins: num(r.voiceJoins),
    voiceSeconds: num(r.voiceSeconds),
    score: num(r.score),
  }));
}

module.exports = {
  fetchServerSeries,
  fetchServerTotals,
  fetchMemberEventSeries,
  fetchMemberSeries,
  fetchLeaderboard,
};
