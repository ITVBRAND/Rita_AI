import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export const env = {
  botToken: process.env.BOT_TOKEN?.trim() || "",
  adminUserIds: new Set(
    (process.env.ADMIN_USER_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  /** Главный владелец(ы) бота: client- и staff-режим без ограничений сотрудника */
  botOwnerUserIds: new Set(
    (process.env.BOT_OWNER_ID || process.env.BOT_OWNER_IDS || "824020353")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  databaseUrl: process.env.DATABASE_URL || "postgresql://rita_app:change-me@localhost:5432/rita_pm?schema=public",
  openaiApiKey: process.env.OPENAI_API_KEY?.trim() || "",
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  openaiModel: process.env.OPENAI_MODEL || "gpt-6.1-terra",
  openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  memoryTimezone: process.env.MEMORY_TIMEZONE || "Europe/Moscow",
  weeekApiToken: process.env.WEEEK_API_TOKEN?.trim() || "",
  get classifyMode(): "script" | "llm" {
    return this.openaiApiKey ? "llm" : "script";
  },
};

export function assertBotToken(): string {
  return required("BOT_TOKEN");
}

export function isAdmin(userId: number | undefined): boolean {
  if (!userId) return false;
  if (env.adminUserIds.size === 0) return false;
  return env.adminUserIds.has(String(userId));
}

export function isBotOwner(userId: number | undefined): boolean {
  if (!userId) return false;
  return env.botOwnerUserIds.has(String(userId));
}
