-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('active', 'ended', 'archived');

-- CreateTable
CREATE TABLE "BotSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "globalPartnerAccess" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BotSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildConfig" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "guildName" TEXT,
    "logChannelId" TEXT,
    "campaignAccess" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuildConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerGuildId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "roleServerId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "roleAutoCreated" BOOLEAN NOT NULL DEFAULT true,
    "startAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'active',
    "verificationActivityCount" INTEGER NOT NULL DEFAULT 0,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequiredServer" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inviteLink" TEXT NOT NULL,

    CONSTRAINT "RequiredServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostedEmbed" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,

    CONSTRAINT "PostedEmbed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignMember" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastKnownUsername" TEXT,
    "serverStatus" JSONB NOT NULL DEFAULT '{}',
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "roleAssigned" BOOLEAN NOT NULL DEFAULT false,
    "firstVerifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuildConfig_guildId_key" ON "GuildConfig"("guildId");

-- CreateIndex
CREATE INDEX "Campaign_ownerGuildId_status_idx" ON "Campaign"("ownerGuildId", "status");

-- CreateIndex
CREATE INDEX "RequiredServer_campaignId_idx" ON "RequiredServer"("campaignId");

-- CreateIndex
CREATE INDEX "RequiredServer_guildId_idx" ON "RequiredServer"("guildId");

-- CreateIndex
CREATE INDEX "PostedEmbed_campaignId_idx" ON "PostedEmbed"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignMember_campaignId_eligible_idx" ON "CampaignMember"("campaignId", "eligible");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMember_campaignId_userId_key" ON "CampaignMember"("campaignId", "userId");

-- AddForeignKey
ALTER TABLE "RequiredServer" ADD CONSTRAINT "RequiredServer_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostedEmbed" ADD CONSTRAINT "PostedEmbed_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMember" ADD CONSTRAINT "CampaignMember_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
