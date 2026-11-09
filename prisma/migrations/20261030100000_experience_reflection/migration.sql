ALTER TABLE "Lesson"
  ADD COLUMN "condition" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "action" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "rationale" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
  ADD COLUMN "utilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  ADD COLUMN "sourceExperienceIds" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "embedding" TEXT,
  ADD COLUMN "embeddingVector" vector(1536),
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Lesson_userId_active_utilityScore_idx"
  ON "Lesson"("userId", "active", "utilityScore");
CREATE INDEX "Lesson_active_confidence_utilityScore_idx"
  ON "Lesson"("active", "confidence", "utilityScore");
CREATE INDEX "Lesson_embeddingVector_hnsw_idx"
  ON "Lesson" USING hnsw ("embeddingVector" vector_cosine_ops);

CREATE TABLE "Experience" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "userText" TEXT NOT NULL,
  "assistantText" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "success" BOOLEAN,
  "reflectionAttempts" INTEGER NOT NULL DEFAULT 0,
  "reflectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Experience_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Experience_reflectedAt_createdAt_idx"
  ON "Experience"("reflectedAt", "createdAt");
CREATE INDEX "Experience_userId_createdAt_idx"
  ON "Experience"("userId", "createdAt");
