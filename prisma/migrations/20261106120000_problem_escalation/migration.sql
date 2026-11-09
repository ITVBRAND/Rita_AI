-- CreateTable
CREATE TABLE "ProblemEscalation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientChatId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "clientLabel" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "messageIds" TEXT NOT NULL DEFAULT '[]',
    "hasMedia" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ticketId" TEXT,
    "escalateAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemEscalation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProblemEscalation_status_escalateAt_idx" ON "ProblemEscalation"("status", "escalateAt");

-- CreateIndex
CREATE INDEX "ProblemEscalation_clientChatId_status_idx" ON "ProblemEscalation"("clientChatId", "status");
