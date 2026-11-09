import { prisma } from "../db/client.js";
import { rememberLesson, touchDialogueSummary } from "../memory/ritaMemory.js";
import { processPendingMemory, semanticTurnSearch } from "../memory/semanticMemory.js";
import { recordLearningExperience } from "../memory/experienceLearning.js";

const PROMPT_LINES = 12;
const RECALL_LINES = 12;
const TEXT_LIMIT = 4000;
const MAX_SCAN = 1200;
const locks = new Map<string, Promise<void>>();

export interface StaffThreadLine {
  who: "user" | "rita";
  text: string;
  createdAt?: Date;
  chatId?: string;
}

async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => (release = resolve));
  const queued = prev.then(() => next);
  locks.set(key, queued);
  await prev;
  try { return await action(); }
  finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

export async function saveStaffUserTurn(
  chatId: string,
  userId: number,
  text: string,
  updateId?: number,
): Promise<boolean> {
  const uid = String(userId);
  const eventKey = updateId == null ? null : `tg:${updateId}:user`;
  return insertTurn(chatId, uid, "user", text, eventKey);
}

async function insertTurn(
  chatId: string,
  userId: string,
  who: "user" | "rita",
  text: string,
  eventKey: string | null,
): Promise<boolean> {
  const lockKey = `${chatId}:${userId}`;
  return serialized(lockKey, async () => {
    if (eventKey && await prisma.dialogueTurn.findUnique({ where: { eventKey }, select: { id: true } })) return false;
    await prisma.$transaction(async (tx) => {
      const last = await tx.dialogueTurn.findFirst({
        where: { chatId, userId }, orderBy: { seq: "desc" }, select: { seq: true },
      });
      const turn = await tx.dialogueTurn.create({
        data: { chatId, userId, seq: (last?.seq ?? 0) + 1, who, text: text.slice(0, TEXT_LIMIT), eventKey },
      });
      await tx.turnMemoryIndex.create({ data: { turnId: turn.id, userId, chatId } });
    });
    return true;
  });
}

export async function appendStaffExchange(
  chatId: string, userId: number, userText: string, ritaText: string, updateId?: number,
): Promise<void> {
  const uid = String(userId);
  try {
    if (updateId != null && await prisma.dialogueTurn.findUnique({ where: { eventKey: `tg:${updateId}:rita` }, select: { id: true } })) return;
    await saveStaffUserTurn(chatId, userId, userText, updateId);
    await insertTurn(chatId, uid, "rita", ritaText, updateId == null ? null : `tg:${updateId}:rita`);
    await touchDialogueSummary(chatId, uid, userText.slice(0, TEXT_LIMIT), ritaText.slice(0, TEXT_LIMIT));
    const source = updateId == null ? null : await prisma.dialogueTurn.findUnique({ where: { eventKey: `tg:${updateId}:user` }, select: { id: true } });
    await rememberLesson(userText, chatId, uid, source ? [source.id] : []);
    await recordLearningExperience({ userId, chatId, userText, assistantText: ritaText });
    void processPendingMemory(uid).catch((error) => console.error("memory queue failed", error));
  } catch (e) {
    console.error("dialogue save failed", e);
  }
}

export async function getStaffTurns(chatId: string, userId?: number, excludeUpdateId?: number): Promise<StaffThreadLine[]> {
  if (userId == null) return [];
  const rows = await prisma.dialogueTurn.findMany({
    where: { chatId, userId: String(userId), ...(excludeUpdateId == null ? {} : { NOT: { eventKey: `tg:${excludeUpdateId}:user` } }) }, orderBy: { seq: "desc" }, take: PROMPT_LINES,
    select: { who: true, text: true, createdAt: true },
  });
  return rows.reverse().map((r) => ({ who: r.who === "rita" ? "rita" : "user", text: r.text, createdAt: r.createdAt }));
}

export async function getStaffThread(chatId: string, userId?: number): Promise<string> {
  return (await getStaffTurns(chatId, userId)).map((l) => `${l.who}: ${l.text}`).join("\n");
}

const STOP = new Set("rita рита что это как для меня тебе тебя просто сейчас можно нужно чтобы когда если или уже еще этот была было были быть есть свой свою наши ваши вчера сегодня разговор обсуждали говорили помнишь".split(" "));
function tokens(text: string): string[] {
  return (text.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w));
}
const PAST_RE = /помн|вспомн|раньше|прошл|вчера|позавчера|обсуждал|говорил|писал|просил|решили|договорил|истори|переписк|на прошлой неделе|неделю назад/i;
export function asksAboutPastDialogue(text: string): boolean { return PAST_RE.test(text); }

function dateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
function localMidnightUtc(day: string, timeZone: string): Date {
  const utcGuess = new Date(`${day}T00:00:00Z`).getTime();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(utcGuess));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const displayedAsUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return new Date(utcGuess - (displayedAsUtc - utcGuess));
}
function requestedRange(query: string, timeZone: string): { from?: Date; to?: Date } {
  const today = dateKey(new Date(), timeZone);
  const match = query.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  let day: string | undefined;
  if (match) day = match[0];
  else if (/позавчера/i.test(query)) day = shiftDate(today, -2);
  else if (/вчера/i.test(query)) day = shiftDate(today, -1);
  else if (/сегодня/i.test(query)) day = today;
  if (day) return { from: localMidnightUtc(day, timeZone), to: localMidnightUtc(shiftDate(day, 1), timeZone) };
  if (/на прошлой неделе|неделю назад|за прошлую неделю/i.test(query)) {
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    const mondayDelta = dow === 0 ? -6 : 1 - dow;
    const mondayThisWeek = shiftDate(today, mondayDelta);
    const mondayLast = shiftDate(mondayThisWeek, -7);
    return { from: localMidnightUtc(mondayLast, timeZone), to: localMidnightUtc(mondayThisWeek, timeZone) };
  }
  return {};
}

export async function recallEarlierTurns(chatId: string, userId: number | undefined, query: string, timeZone = "Europe/Moscow", forceSemantic = false): Promise<StaffThreadLine[]> {
  if (userId == null) return [];
  const range = requestedRange(query, timeZone);
  const uid = String(userId);
  const rows = await prisma.dialogueTurn.findMany({
    where: { userId: uid, ...(range.from || range.to ? { createdAt: { gte: range.from, lt: range.to } } : {}) },
    orderBy: { createdAt: "desc" }, take: MAX_SCAN,
    select: { id: true, chatId: true, who: true, text: true, createdAt: true },
  });
  const chronological = rows.reverse();
  const currentChatTail = range.from ? new Set<string>() : new Set((await prisma.dialogueTurn.findMany({ where: { chatId, userId: uid }, orderBy: { seq: "desc" }, take: PROMPT_LINES, select: { id: true } })).map((r) => r.id));
  const extra = (forceSemantic || asksAboutPastDialogue(query)) ? await semanticTurnSearch(uid, query, RECALL_LINES) : [];
  const candidateMap = new Map(chronological.filter((r) => !currentChatTail.has(r.id)).map((r) => [r.id, r]));
  for (const hit of extra) {
    const turn = hit.turn;
    if (currentChatTail.has(turn.id) || (range.from && turn.createdAt < range.from) || (range.to && turn.createdAt >= range.to)) continue;
    candidateMap.set(turn.id, turn);
  }
  const candidateRows = [...candidateMap.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const sourceIds = new Set(extra.map((hit) => hit.turn.id));
  if (range.from) return candidateRows.slice(-RECALL_LINES).map((r) => ({ who: r.who === "rita" ? "rita" : "user", text: r.text, createdAt: r.createdAt, chatId: r.chatId || undefined }));
  const queryTokens = new Set(tokens(query));
  const ranked = candidateRows.map((r, i) => {
    const line = new Set(tokens(r.text));
    let score = 0; for (const token of queryTokens) if (line.has(token)) score++;
    if (sourceIds.has(r.id)) score += 2;
    return { r, i, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.i - a.i).slice(0, 4);
  if (!ranked.length && !asksAboutPastDialogue(query)) return [];
  const indexes = new Set<number>();
  for (const hit of ranked) { indexes.add(hit.i); if (hit.i > 0) indexes.add(hit.i - 1); if (hit.i + 1 < candidateRows.length) indexes.add(hit.i + 1); }
  if (!ranked.length) for (let i = Math.max(0, candidateRows.length - RECALL_LINES); i < candidateRows.length; i++) indexes.add(i);
  return [...indexes].sort((a, b) => a - b).slice(-RECALL_LINES).map((i) => ({ who: candidateRows[i].who === "rita" ? "rita" : "user", text: candidateRows[i].text, createdAt: candidateRows[i].createdAt, chatId: candidateRows[i].chatId || undefined }));
}
