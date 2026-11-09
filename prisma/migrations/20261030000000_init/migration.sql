CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatBinding" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "skill" TEXT NOT NULL DEFAULT 'general',
    "label" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ChatBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'collecting',
    "skill" TEXT NOT NULL DEFAULT 'general',
    "summary" TEXT NOT NULL,
    "orderRef" TEXT,
    "clientChatId" TEXT NOT NULL,
    "executorChatIds" TEXT NOT NULL DEFAULT '[]',
    "openedByUserId" TEXT,
    "assigneeUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "telegramMessageId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "hasMedia" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketLink" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "telegramMessageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "TicketLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meta" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Meta_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "DialogueTurn" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "who" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "eventKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DialogueTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TurnMemoryIndex" (
    "id" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "embedding" TEXT,
    "embeddingVector" vector(1536),
    "embeddingModel" TEXT,
    "extractedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TurnMemoryIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DialogueSummary" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DialogueSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "chatId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceTurnIds" TEXT NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "replacesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedMemory" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceTurnIds" TEXT NOT NULL DEFAULT '[]',
    "sourceUserId" TEXT,
    "createdBy" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "embedding" TEXT,
    "embeddingVector" vector(1536),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "ChatBinding_chatId_idx" ON "ChatBinding"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatBinding_projectId_chatId_key" ON "ChatBinding"("projectId", "chatId");

-- CreateIndex
CREATE INDEX "Ticket_status_idx" ON "Ticket"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_projectId_number_key" ON "Ticket"("projectId", "number");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_idx" ON "TicketMessage"("ticketId");

-- CreateIndex
CREATE INDEX "TicketMessage_chatId_telegramMessageId_idx" ON "TicketMessage"("chatId", "telegramMessageId");

-- CreateIndex
CREATE INDEX "TicketLink_ticketId_idx" ON "TicketLink"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketLink_chatId_telegramMessageId_key" ON "TicketLink"("chatId", "telegramMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "DialogueTurn_eventKey_key" ON "DialogueTurn"("eventKey");

-- CreateIndex
CREATE INDEX "DialogueTurn_chatId_userId_seq_idx" ON "DialogueTurn"("chatId", "userId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "TurnMemoryIndex_turnId_key" ON "TurnMemoryIndex"("turnId");

-- CreateIndex
CREATE INDEX "TurnMemoryIndex_userId_createdAt_idx" ON "TurnMemoryIndex"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TurnMemoryIndex_extractedAt_createdAt_idx" ON "TurnMemoryIndex"("extractedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DialogueSummary_chatId_userId_key" ON "DialogueSummary"("chatId", "userId");

-- CreateIndex
CREATE INDEX "Lesson_userId_chatId_createdAt_idx" ON "Lesson"("userId", "chatId", "createdAt");

-- CreateIndex
CREATE INDEX "Memory_userId_active_updatedAt_idx" ON "Memory"("userId", "active", "updatedAt");

-- CreateIndex
CREATE INDEX "Memory_chatId_userId_active_idx" ON "Memory"("chatId", "userId", "active");

-- CreateIndex
CREATE INDEX "SharedMemory_category_active_updatedAt_idx" ON "SharedMemory"("category", "active", "updatedAt");

-- CreateIndex
CREATE INDEX "SharedMemory_active_updatedAt_idx" ON "SharedMemory"("active", "updatedAt");

-- Create vector indexes for semantic retrieval.
CREATE INDEX "TurnMemoryIndex_embeddingVector_hnsw_idx"
ON "TurnMemoryIndex" USING hnsw ("embeddingVector" vector_cosine_ops);

CREATE INDEX "SharedMemory_embeddingVector_hnsw_idx"
ON "SharedMemory" USING hnsw ("embeddingVector" vector_cosine_ops);

-- AddForeignKey
ALTER TABLE "ChatBinding" ADD CONSTRAINT "ChatBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TurnMemoryIndex" ADD CONSTRAINT "TurnMemoryIndex_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "DialogueTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
