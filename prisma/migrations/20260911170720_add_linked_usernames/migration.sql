-- CreateTable
CREATE TABLE "LinkedUsername" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "usernameLower" TEXT NOT NULL,
    "lockedByUser" BOOLEAN NOT NULL DEFAULT true,
    "setByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedUsername_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkedUsername_discordUserId_key" ON "LinkedUsername"("discordUserId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedUsername_usernameLower_key" ON "LinkedUsername"("usernameLower");
