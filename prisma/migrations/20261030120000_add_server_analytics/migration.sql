-- CreateTable
CREATE TABLE "GuildAnalyticsConfig" (
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trackingStartedAt" TIMESTAMP(3) NOT NULL,
    "pausedFrom" TIMESTAMP(3),
    "pausedTo" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuildAnalyticsConfig_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "ActivityHourly" (
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "reactions" INTEGER NOT NULL DEFAULT 0,
    "voiceJoins" INTEGER NOT NULL DEFAULT 0,
    "voiceSeconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActivityHourly_pkey" PRIMARY KEY ("guildId","bucket","userId")
);

-- CreateTable
CREATE TABLE "ActivityMemberEvent" (
    "id" BIGSERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityMemberEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityVoiceSession" (
    "id" BIGSERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "ActivityVoiceSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityHourly_guildId_userId_bucket_idx" ON "ActivityHourly"("guildId", "userId", "bucket");

-- CreateIndex
CREATE INDEX "ActivityMemberEvent_guildId_occurredAt_idx" ON "ActivityMemberEvent"("guildId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityMemberEvent_guildId_userId_type_occurredAt_key" ON "ActivityMemberEvent"("guildId", "userId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityVoiceSession_guildId_userId_endedAt_idx" ON "ActivityVoiceSession"("guildId", "userId", "endedAt");

-- CreateIndex
CREATE INDEX "ActivityVoiceSession_guildId_startedAt_idx" ON "ActivityVoiceSession"("guildId", "startedAt");
