import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = path.join(root, "prisma", "rita-memory-test.db");
const env = { ...process.env, DATABASE_URL: "file:./rita-memory-test.db", OPENAI_API_KEY: "" };
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
try {
  rmSync(db, { force: true });
  rmSync(`${db}-journal`, { force: true });
  const sqlite = new DatabaseSync(db);
  sqlite.exec(`
    CREATE TABLE DialogueTurn (id TEXT PRIMARY KEY, chatId TEXT NOT NULL, userId TEXT NOT NULL, seq INTEGER NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL, eventKey TEXT UNIQUE, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX DialogueTurn_chatId_userId_seq_idx ON DialogueTurn(chatId, userId, seq);
    CREATE TABLE TurnMemoryIndex (id TEXT PRIMARY KEY, turnId TEXT NOT NULL UNIQUE, userId TEXT NOT NULL, chatId TEXT NOT NULL, embedding TEXT, embeddingModel TEXT, extractedAt DATETIME, attempts INTEGER NOT NULL DEFAULT 0, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX TurnMemoryIndex_userId_createdAt_idx ON TurnMemoryIndex(userId, createdAt);
    CREATE INDEX TurnMemoryIndex_extractedAt_createdAt_idx ON TurnMemoryIndex(extractedAt, createdAt);
    CREATE TABLE Lesson (id TEXT PRIMARY KEY, text TEXT NOT NULL, chatId TEXT, userId TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX Lesson_userId_chatId_createdAt_idx ON Lesson(userId, chatId, createdAt);
    CREATE TABLE Memory (id TEXT PRIMARY KEY, userId TEXT NOT NULL, chatId TEXT, category TEXT NOT NULL, content TEXT NOT NULL, sourceTurnIds TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 1, active BOOLEAN NOT NULL DEFAULT 1, replacesId TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX Memory_userId_active_updatedAt_idx ON Memory(userId, active, updatedAt);
    CREATE INDEX Memory_chatId_userId_active_idx ON Memory(chatId, userId, active);
    CREATE TABLE SharedMemory (id TEXT PRIMARY KEY, category TEXT NOT NULL, content TEXT NOT NULL, sourceTurnIds TEXT NOT NULL DEFAULT '[]', sourceUserId TEXT, createdBy TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1, embedding TEXT, active BOOLEAN NOT NULL DEFAULT 1, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX SharedMemory_category_active_updatedAt_idx ON SharedMemory(category, active, updatedAt);
    CREATE INDEX SharedMemory_active_updatedAt_idx ON SharedMemory(active, updatedAt);
  `);
  sqlite.close();
  execFileSync(process.execPath, [tsx, "--test", "tests/memory.test.ts"], { cwd: root, env, stdio: "inherit" });
} finally {
  rmSync(db, { force: true });
  rmSync(`${db}-journal`, { force: true });
  rmSync(`${db}-wal`, { force: true });
  rmSync(`${db}-shm`, { force: true });
}
