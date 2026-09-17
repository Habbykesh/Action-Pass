-- CreateTable
CREATE TABLE "ActionModelSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "guildId" TEXT NOT NULL,
    "embedTitle" TEXT NOT NULL DEFAULT 'ACTION MODEL',
    "embedDescription" TEXT NOT NULL DEFAULT 'Complete verification below to get access.',
    "embedImageUrl" TEXT,
    "verifyButtonLabel" TEXT NOT NULL DEFAULT '✅ Verify',
    "verificationRoleId" TEXT,
    "campaignButtonLabel" TEXT NOT NULL DEFAULT '🏆 Alpha Winners',
    "campaignRoleId" TEXT,
    "campaignRoleName" TEXT,
    "panelChannelId" TEXT,
    "panelMessageId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionModelSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessCode" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "codeUpper" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedByUserId" TEXT,
    "usedByName" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActionModelSettings_guildId_key" ON "ActionModelSettings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessCode_code_key" ON "AccessCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "AccessCode_codeUpper_key" ON "AccessCode"("codeUpper");

-- CreateIndex
CREATE INDEX "AccessCode_guildId_used_idx" ON "AccessCode"("guildId", "used");
