-- CreateTable
CREATE TABLE "RolePanel" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "internalName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "channelId" TEXT,
    "messageId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RolePanel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePanelButton" (
    "id" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT,
    "style" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "RolePanelButton_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RolePanel_guildId_internalName_key" ON "RolePanel"("guildId", "internalName");

-- CreateIndex
CREATE INDEX "RolePanelButton_panelId_idx" ON "RolePanelButton"("panelId");

-- AddForeignKey
ALTER TABLE "RolePanelButton" ADD CONSTRAINT "RolePanelButton_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "RolePanel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
