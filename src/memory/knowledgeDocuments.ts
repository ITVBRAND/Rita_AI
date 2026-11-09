import { createHash } from "node:crypto";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { prisma } from "../db/client.js";
import { env } from "../env.js";
import { openaiJson } from "../ai/openaiHttp.js";

export const MAX_KNOWLEDGE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 800_000;
const MAX_CHUNKS = 600;
const CHUNK_SIZE = 1_600;
const CHUNK_OVERLAP = 220;
const EMBEDDING_BATCH = 32;

export class KnowledgeDocumentError extends Error {}

function extensionOf(fileName: string): "pdf" | "docx" | null {
  const match = fileName.toLowerCase().match(/\.(pdf|docx)$/);
  return match?.[1] === "pdf" ? "pdf" : match?.[1] === "docx" ? "docx" : null;
}

async function readTelegramDownload(filePath: string): Promise<Buffer> {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`https://api.telegram.org/file/bot${env.botToken}/${encodedPath}`, {
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok || !response.body) throw new KnowledgeDocumentError("Не удалось скачать файл из Telegram.");
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_KNOWLEDGE_FILE_BYTES) throw new KnowledgeDocumentError("Файл больше лимита 20 МБ.");
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > MAX_KNOWLEDGE_FILE_BYTES) {
      await reader.cancel();
      throw new KnowledgeDocumentError("Файл больше лимита 20 МБ.");
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts, size);
}

async function extractText(buffer: Buffer, type: "pdf" | "docx"): Promise<string> {
  if (type === "pdf") {
    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new KnowledgeDocumentError("Файл не похож на PDF.");
    const parser = new PDFParse({ data: buffer });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (buffer.subarray(0, 2).toString("ascii") !== "PK") throw new KnowledgeDocumentError("Файл не похож на DOCX.");
  return (await mammoth.extractRawText({ buffer })).value;
}

function splitIntoChunks(raw: string): string[] {
  const text = raw.replace(/\u0000/g, " ").replace(/\r/g, "").replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_CHARS);
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf(". ", end));
      if (boundary > start + CHUNK_SIZE * 0.6) end = boundary + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length >= 40) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const result = await openaiJson<{ data?: Array<{ index: number; embedding?: number[] }> }>("embeddings", {
    model: env.openaiEmbeddingModel,
    input: texts,
    encoding_format: "float",
  });
  const vectors = new Array<number[]>(texts.length);
  for (const row of result.data ?? []) {
    if (Number.isInteger(row.index) && row.index >= 0 && row.index < texts.length && row.embedding?.length === 1536) vectors[row.index] = row.embedding;
  }
  if (vectors.some((vector) => !vector)) throw new Error("Embedding API returned incomplete vectors.");
  return vectors;
}

async function writeChunkVector(chunkId: string, vector: number[]): Promise<void> {
  const literal = `[${vector.join(",")}]`;
  await prisma.$executeRaw`UPDATE "KnowledgeChunk" SET "embeddingVector" = ${literal}::vector WHERE "id" = ${chunkId}`;
}

export async function indexKnowledgeDocument(input: {
  filePath: string;
  fileName: string;
  mimeType: string;
  uploadedBy: string;
}): Promise<{ id: string; title: string; chunkCount: number; alreadyIndexed: boolean }> {
  if (!env.openaiApiKey) throw new KnowledgeDocumentError("Для индексации документов нужен настроенный OpenAI API key.");
  const type = extensionOf(input.fileName);
  if (!type) throw new KnowledgeDocumentError("Поддерживаются только файлы PDF и DOCX.");
  const buffer = await readTelegramDownload(input.filePath);
  if (!buffer.length) throw new KnowledgeDocumentError("Файл пустой.");
  const extracted = (await extractText(buffer, type)).slice(0, MAX_TEXT_CHARS);
  const chunks = splitIntoChunks(extracted);
  if (!chunks.length) throw new KnowledgeDocumentError("В документе не нашёлся текст. Для сканированных PDF пока нужна OCR-обработка.");

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const title = input.fileName.replace(/\.(pdf|docx)$/i, "").slice(0, 250) || "Без названия";
  const existing = await prisma.knowledgeDocument.findUnique({ where: { sha256 }, select: { id: true, active: true, status: true, chunkCount: true, title: true } });
  if (existing?.active && existing.status === "ready") {
    return { id: existing.id, title: existing.title, chunkCount: existing.chunkCount, alreadyIndexed: true };
  }

  const document = await prisma.knowledgeDocument.upsert({
    where: { sha256 },
    create: {
      title, fileName: input.fileName.slice(0, 500), mimeType: input.mimeType.slice(0, 200), sha256,
      uploadedBy: input.uploadedBy, byteSize: buffer.length, textLength: extracted.length,
      chunkCount: 0, status: "indexing", active: true,
    },
    update: {
      title, fileName: input.fileName.slice(0, 500), mimeType: input.mimeType.slice(0, 200), uploadedBy: input.uploadedBy,
      byteSize: buffer.length, textLength: extracted.length, chunkCount: 0, status: "indexing", active: true,
    },
  });
  await prisma.knowledgeChunk.deleteMany({ where: { documentId: document.id } });

  try {
    for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH) {
      const texts = chunks.slice(offset, offset + EMBEDDING_BATCH);
      const vectors = await embedBatch(texts);
      for (let i = 0; i < texts.length; i++) {
        const chunk = await prisma.knowledgeChunk.create({
          data: { documentId: document.id, chunkIndex: offset + i, text: texts[i], embedding: JSON.stringify(vectors[i]) },
          select: { id: true },
        });
        await writeChunkVector(chunk.id, vectors[i]);
      }
    }
    await prisma.knowledgeDocument.update({ where: { id: document.id }, data: { status: "ready", chunkCount: chunks.length } });
  } catch (error) {
    await prisma.knowledgeChunk.deleteMany({ where: { documentId: document.id } });
    await prisma.knowledgeDocument.update({ where: { id: document.id }, data: { status: "failed", chunkCount: 0 } });
    throw error;
  }
  return { id: document.id, title, chunkCount: chunks.length, alreadyIndexed: false };
}

export async function searchKnowledgeDocuments(query: string, limit = 5): Promise<Array<{ title: string; fileName: string; text: string; score: number }>> {
  if (!env.openaiApiKey || !query.trim()) return [];
  try {
    const result = await openaiJson<{ data?: Array<{ embedding?: number[] }> }>("embeddings", {
      model: env.openaiEmbeddingModel,
      input: query.slice(0, 3000),
      encoding_format: "float",
    });
    const vector = result.data?.[0]?.embedding;
    if (!vector || vector.length !== 1536) return [];
    const literal = `[${vector.join(",")}]`;
    return prisma.$queryRaw<Array<{ title: string; fileName: string; text: string; score: number }>>`
      SELECT d."title", d."fileName", c."text", 1 - (c."embeddingVector" <=> ${literal}::vector) AS score
      FROM "KnowledgeChunk" c
      INNER JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
      WHERE d."active" = TRUE AND d."status" = 'ready' AND c."embeddingVector" IS NOT NULL
        AND 1 - (c."embeddingVector" <=> ${literal}::vector) >= 0.22
      ORDER BY c."embeddingVector" <=> ${literal}::vector
      LIMIT ${Math.max(1, Math.min(limit, 10))}
    `;
  } catch (error) {
    console.error("document knowledge search failed", error);
    return [];
  }
}

export async function formatDocumentKnowledgeForPrompt(query: string): Promise<string> {
  const hits = await searchKnowledgeDocuments(query, 5);
  return hits.map((hit) => `- [${hit.title}; ${hit.fileName}; relevance ${hit.score.toFixed(2)}]\n${hit.text.slice(0, 1_200)}`).join("\n\n").slice(0, 6_000);
}

export function listKnowledgeDocuments() {
  return prisma.knowledgeDocument.findMany({
    where: { active: true }, orderBy: { createdAt: "desc" }, take: 40,
    select: { id: true, title: true, fileName: true, status: true, chunkCount: true, createdAt: true },
  });
}

export async function deactivateKnowledgeDocument(id: string): Promise<boolean> {
  return (await prisma.knowledgeDocument.updateMany({ where: { id, active: true }, data: { active: false } })).count > 0;
}
