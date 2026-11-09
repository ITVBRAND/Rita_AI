CREATE TABLE "ChatBindingRevocation" (
  "id" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "disabledBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatBindingRevocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatBindingRevocation_chatId_key" ON "ChatBindingRevocation"("chatId");
