import { prisma } from "../db/client.js";
import { env } from "../env.js";
import { openaiJson } from "../ai/openaiHttp.js";

const LEARN_RE = /запомни|в\s+следующ(?:ий|ем)\s+раз|больше\s+не|не\s+надо\s+было|нужно\s+было|не\s+так|ты\s+не\s+(?:передала|поняла|сделала|сообщила)/iu;
const STATUS_ASK_RE = /какой\s+статус|что\s+со\s+статус|какие\s+проблем|что\s+в\s+работе|что\s+(?:уже\s+)?решил|статус\s+(?:ошиб|задач|обращен)/iu;
const STATUS_LABEL: Record<string, string> = {
  collecting: "уточняем у клиента", open: "передано разработчикам", in_progress: "в работе",
  waiting_client: "ждём клиента", waiting_executor: "ждём разработчиков", resolved: "решено", cancelled: "отменено",
};

export function asksForProblemStatus(text: string): boolean { return STATUS_ASK_RE.test(text); }

export function lessonTextFrom(text: string): string | null {
  if (!LEARN_RE.test(text)) return null;
  const cleaned = text.replace(/^(?:рита|рит|маргарита)[,!]?\s*/iu, "").trim();
  if (cleaned.length < 8) return null;
  return cleaned.slice(0, 500);
}

export async function rememberLesson(text: string, chatId?: string, userId?: string, sourceTurnIds: string[] = []): Promise<boolean> {
  const lesson = lessonTextFrom(text);
  if (!lesson || !userId) return false;
  const existing = await prisma.lesson.findFirst({ where: { text: lesson, userId } });
  if (existing) return true;
  await prisma.lesson.create({ data: { text: lesson, chatId: chatId ?? null, userId } });
  await saveMemory(userId, chatId ?? null, "rule", lesson, sourceTurnIds);
  return true;
}

export async function formatLessonsForPrompt(userId: string): Promise<string> {
  const rows = await prisma.lesson.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 });
  return rows.reverse().map((row) => `• ${row.text}`).join("\n");
}

export async function saveMemory(userId: string, chatId: string | null, category: string, content: string, sourceTurnIds: string[]): Promise<void> {
  const normalized = content.trim().slice(0, 1000);
  if (normalized.length < 5) return;
  const recent = await prisma.memory.findMany({ where: { userId, active: true, category }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, content: true } });
  const canonical = (s: string) => s.toLocaleLowerCase("ru-RU").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const found = recent.find((row) => canonical(row.content) === canonical(normalized));
  if (found) {
    if (sourceTurnIds.length && found.id) {
      const current = await prisma.memory.findUnique({ where: { id: found.id }, select: { sourceTurnIds: true } });
      let existingIds: string[] = [];
      try { existingIds = current ? JSON.parse(current.sourceTurnIds) as string[] : []; } catch { /* ignore malformed data */ }
      const merged = [...new Set([...existingIds, ...sourceTurnIds])];
      await prisma.memory.update({ where: { id: found.id }, data: { sourceTurnIds: JSON.stringify(merged) } });
    }
    return;
  }
  await prisma.memory.create({ data: { userId, chatId, category, content: normalized, sourceTurnIds: JSON.stringify(sourceTurnIds) } });
}

export async function formatMemoriesForPrompt(userId: string, _chatId?: string): Promise<string> {
  const rows = await prisma.memory.findMany({ where: { userId, active: true }, orderBy: { updatedAt: "desc" }, take: 30 });
  return rows.map((row) => `? [${row.category}${row.chatId ? `; chat ${row.chatId}` : ""}] ${row.content}`).join("\n");
}

export async function listMemories(userId: string, _chatId?: string) {
  return prisma.memory.findMany({ where: { userId, active: true }, orderBy: { updatedAt: "desc" }, take: 30 });
}

export async function forgetMemory(userId: string, id: string): Promise<boolean> {
  return (await prisma.memory.updateMany({ where: { id, userId, active: true }, data: { active: false } })).count > 0;
}

export async function findMemorySource(userId: string, id: string) {
  const memory = await prisma.memory.findFirst({ where: { id, userId } });
  if (!memory) return null;
  let ids: string[] = [];
  try { ids = JSON.parse(memory.sourceTurnIds) as string[]; } catch { /* ignore malformed data */ }
  const turns = ids.length ? await prisma.dialogueTurn.findMany({ where: { id: { in: ids }, userId }, orderBy: { seq: "asc" } }) : [];
  return { memory, turns };
}

export async function touchDialogueSummary(chatId: string, userId: string, userText: string, ritaText: string): Promise<void> {
  const line = `Коллега: ${userText.replace(/\s+/g, " ").slice(0, 180)}\nРита: ${ritaText.replace(/\s+/g, " ").slice(0, 180)}`;
  const prev = await prisma.dialogueSummary.findUnique({ where: { chatId_userId: { chatId, userId } } });
  const summary = [prev?.summary, line].filter(Boolean).join("\n").split("\n").slice(-16).join("\n");
  await prisma.dialogueSummary.upsert({
    where: { chatId_userId: { chatId, userId } }, create: { chatId, userId, summary }, update: { summary },
  });
}

export async function getDialogueSummary(chatId: string, userId: string): Promise<string> {
  return (await prisma.dialogueSummary.findUnique({ where: { chatId_userId: { chatId, userId } } }))?.summary ?? "";
}

export async function formatProblemStatus(projectId: string): Promise<string> {
  const tickets = await prisma.ticket.findMany({ where: { projectId }, orderBy: { updatedAt: "desc" }, take: 8 });
  if (!tickets.length) return "Открытых обращений пока нет.";
  return tickets.map((t) => `• ${STATUS_LABEL[t.status] || t.status}: ${t.summary.slice(0, 220)}${t.resolution ? `\n  Итог: ${t.resolution}` : ""}`).join("\n");
}

export type SharedMemoryCategory = "fact" | "project" | "decision" | "commitment" | "rule" | "creator_allow" | "creator_forbid";

async function embeddingForMemory(text: string): Promise<number[] | null> {
  if (!env.openaiApiKey || !text.trim()) return null;
  try {
    const result = await openaiJson<{ data?: Array<{ embedding?: number[] }> }>("embeddings", {
      model: env.openaiEmbeddingModel,
      input: text.slice(0, 3500),
      encoding_format: "float",
    });
    return result.data?.[0]?.embedding ?? null;
  } catch (error) {
    console.error("shared memory embedding failed", error);
    return null;
  }
}

async function writeSharedVector(id: string, vector: number[]): Promise<void> {
  const literal = `[${vector.join(",")}]`;
  await prisma.$executeRaw`UPDATE "SharedMemory" SET "embeddingVector" = ${literal}::vector WHERE "id" = ${id}`;
}

function parseEmbedding(value: string): number[] | null {
  let decoded: unknown = value;
  for (let depth = 0; depth < 3 && typeof decoded === "string"; depth++) {
    try { decoded = JSON.parse(decoded) as unknown; } catch { return null; }
  }
  return Array.isArray(decoded) && decoded.every((item) => typeof item === "number" && Number.isFinite(item))
    ? decoded as number[]
    : null;
}

export function parseCreatorPolicyInstruction(text: string): { category: "creator_allow" | "creator_forbid"; content: string } | null {
  const normalized = text.trim().replace(/^(?:@?rita|рита)[,!: ]+/iu, "");
  const match = normalized.match(/^(?:remember\s+rule\s*:\s*|запомни\s+правило\s*:\s*|запомни\s*:\s*)(.+)$/iu);
  const body = (match?.[1] ?? normalized).trim();
  const allow = body.match(/^(?:тебе\s+можно|разрешаю|you\s+may)\s+(.+)$/iu);
  if (allow?.[1]) return { category: "creator_allow", content: allow[1].trim() };
  const forbid = body.match(/^(?:тебе\s+нельзя|запрещаю|не\s+смей|you\s+must\s+not)\s+(.+)$/iu);
  if (forbid?.[1]) return { category: "creator_forbid", content: forbid[1].trim() };
  return null;
}

export async function saveSharedMemory(params: {
  category: SharedMemoryCategory;
  content: string;
  createdBy: string;
  sourceUserId?: string;
  sourceTurnIds?: string[];
  confidence?: number;
}): Promise<string | null> {
  const content = params.content.trim().slice(0, 1000);
  if (content.length < 5) return null;
  const canonical = (value: string) => value.toLocaleLowerCase("ru-RU").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const recent = await prisma.sharedMemory.findMany({ where: { category: params.category, active: true }, orderBy: { updatedAt: "desc" }, take: 200 });
  const found = recent.find((row) => canonical(row.content) === canonical(content));
  if (found) {
    const ids = new Set<string>();
    try { for (const id of JSON.parse(found.sourceTurnIds) as string[]) ids.add(id); } catch { /* ignore malformed source data */ }
    for (const id of params.sourceTurnIds ?? []) ids.add(id);
    let vector: number[] | null = null;
    if (!params.category.startsWith("creator_")) {
      if (found.embedding) {
        vector = parseEmbedding(found.embedding);
      }
      vector ??= await embeddingForMemory(content);
    }
    await prisma.sharedMemory.update({ where: { id: found.id }, data: { sourceTurnIds: JSON.stringify([...ids]), confidence: Math.max(found.confidence, params.confidence ?? 1), ...(vector ? { embedding: JSON.stringify(vector) } : {}) } });
    if (vector) await writeSharedVector(found.id, vector);
    return found.id;
  }
  const vector = params.category.startsWith("creator_") ? null : await embeddingForMemory(content);
  const row = await prisma.sharedMemory.create({ data: {
    category: params.category, content, createdBy: params.createdBy,
    sourceUserId: params.sourceUserId ?? null,
    sourceTurnIds: JSON.stringify(params.sourceTurnIds ?? []),
    confidence: params.confidence ?? 1,
    embedding: vector ? JSON.stringify(vector) : null,
  } });
  if (vector) await writeSharedVector(row.id, vector);
  return row.id;
}

export async function backfillSharedMemoryEmbeddings(limit = 50): Promise<number> {
  if (!env.openaiApiKey) return 0;
  const rows = await prisma.sharedMemory.findMany({
    where: { active: true, embedding: null, category: { notIn: ["creator_allow", "creator_forbid"] } },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
  });
  let indexed = 0;
  for (const row of rows) {
    const vector = await embeddingForMemory(row.content);
    if (!vector) break;
    await prisma.sharedMemory.update({ where: { id: row.id }, data: { embedding: JSON.stringify(vector) } });
    await writeSharedVector(row.id, vector);
    indexed++;
  }
  return indexed;
}

export async function formatSharedKnowledgeForPrompt(query?: string): Promise<string> {
  const where = { active: true, category: { in: ["fact", "project", "decision", "commitment", "rule"] } };
  const recent = await prisma.sharedMemory.findMany({
    where, orderBy: { updatedAt: "desc" }, take: 8,
  });
  let rows: Array<{ id: string; category: string; content: string }> = recent.map((row) => ({ id: row.id, category: row.category, content: row.content }));
  const queryVector = query ? await embeddingForMemory(query) : null;
  if (queryVector) {
    const literal = `[${queryVector.join(",")}]`;
    const ranked = await prisma.$queryRaw<Array<{ id: string; category: string; content: string }>>`
      SELECT "id", "category", "content"
      FROM "SharedMemory"
      WHERE "active" = TRUE
        AND "category" IN ('fact', 'project', 'decision', 'commitment', 'rule')
        AND "embeddingVector" IS NOT NULL
      ORDER BY "embeddingVector" <=> ${literal}::vector
      LIMIT 16
    `;
    const selected = new Map<string, { id: string; category: string; content: string }>();
    for (const row of recent) selected.set(row.id, { id: row.id, category: row.category, content: row.content });
    for (const match of ranked) selected.set(match.id, match);
    rows = [...selected.values()];
  }
  return rows.map((row) => `- [${row.category}] ${row.content}`).join("\n");
}

export async function formatCreatorPoliciesForPrompt(): Promise<string> {
  const rows = await prisma.sharedMemory.findMany({
    where: { active: true, category: { in: ["creator_allow", "creator_forbid"] } },
    orderBy: { updatedAt: "desc" }, take: 40,
  });
  return rows.map((row) => `${row.category === "creator_allow" ? "ALLOW" : "FORBID"} [${row.id}]: ${row.content}`).join("\n");
}

export async function listSharedMemory() {
  return prisma.sharedMemory.findMany({ where: { active: true }, orderBy: { updatedAt: "desc" }, take: 50 });
}

export async function deleteSharedMemory(id: string): Promise<boolean> {
  return (await prisma.sharedMemory.updateMany({ where: { id, active: true }, data: { active: false } })).count > 0;
}

export async function creatorForbids(action: "forward" | "weeek" | "implementation"): Promise<boolean> {
  const rows = await prisma.sharedMemory.findMany({ where: { active: true, category: { in: ["creator_allow", "creator_forbid"] } }, orderBy: { updatedAt: "desc" }, select: { category: true, content: true } });
  const words: Record<typeof action, RegExp> = {
    forward: /(forward|send|relay|пересыл|передач|отправ|разработчик|разработк)/iu,
    weeek: /(weeek|task|задач)/iu,
    implementation: /(implement|deploy|release|внедр|развер|публикац)/iu,
  };
  const policy = rows.find((row) => words[action].test(row.content));
  return policy?.category === "creator_forbid";
}
