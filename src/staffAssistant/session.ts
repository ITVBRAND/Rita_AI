import { prisma } from "../db/client.js";
import { rememberLesson, touchDialogueSummary } from "../memory/ritaMemory.js";

/** Сколько последних реплик всегда отдавать в промпт. В базе остаётся вся переписка. */
const PROMPT_LINES = 12;
/** Сколько более ранних реплик можно поднять, если вопрос к ним относится. */
const RECALL_LINES = 8;
const RECALL_SCAN = 400;
const TEXT_LIMIT = 4000;

const PAST_RE =
  /помн|вспомн|раньше|в\s+прошл|мы\s+(?:говорил|обсужда|писал)|ты\s+(?:говорил|писал|отвечал|сказал)|что\s+я\s+(?:говорил|писал|просил)|до\s+этого|тогда\s+ты|истори[юи]\s+(?:диалог|переписк)/iu;

const STOP = new Set([
  "рита",
  "рит",
  "это",
  "что",
  "как",
  "для",
  "меня",
  "тебе",
  "тебя",
  "просто",
  "сейчас",
  "можно",
  "нужно",
  "чтобы",
  "когда",
  "если",
  "или",
  "уже",
  "ещё",
  "еще",
  "только",
  "очень",
  "была",
  "было",
  "были",
  "быть",
  "есть",
  "этот",
  "эта",
  "того",
  "тоже",
  "тебя",
  "свой",
  "свою",
  "наши",
  "ваш",
  "ваша",
]);

export interface StaffThreadLine {
  who: "user" | "rita";
  text: string;
}

export async function appendStaffExchange(
  chatId: string,
  userId: number,
  userText: string,
  ritaText: string,
): Promise<void> {
  const uid = String(userId);
  const turns: Array<{ who: "user" | "rita"; text: string }> = [
    { who: "user", text: userText.slice(0, TEXT_LIMIT) },
    { who: "rita", text: ritaText.slice(0, TEXT_LIMIT) },
  ];
  try {
    await prisma.$transaction(async (tx) => {
      const last = await tx.dialogueTurn.findFirst({
        where: { chatId, userId: uid },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      let seq = last?.seq ?? 0;
      for (const turn of turns) {
        seq += 1;
        await tx.dialogueTurn.create({
          data: {
            chatId,
            userId: uid,
            seq,
            who: turn.who,
            text: turn.text,
          },
        });
      }
    });
    await touchDialogueSummary(chatId, uid, userText.slice(0, TEXT_LIMIT), ritaText.slice(0, TEXT_LIMIT));
    await rememberLesson(userText, chatId);
  } catch (e) {
    console.error("dialogue save failed", e);
  }
}

export async function getStaffTurns(
  chatId: string,
  userId?: number,
): Promise<StaffThreadLine[]> {
  if (!userId) return [];
  const rows = await prisma.dialogueTurn.findMany({
    where: { chatId, userId: String(userId) },
    orderBy: { seq: "desc" },
    take: PROMPT_LINES,
    select: { who: true, text: true },
  });
  return rows.reverse().map((l) => ({
    who: l.who === "rita" ? "rita" : "user",
    text: l.text,
  }));
}

export async function getStaffThread(chatId: string, userId?: number): Promise<string> {
  const rows = await getStaffTurns(chatId, userId);
  return rows.map((l) => `${l.who}: ${l.text}`).join("\n");
}

function contentTokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-zа-яё]{4,}/giu) ?? [];
  return words.filter((w) => !STOP.has(w));
}

/** Вопрос про прошлый разговор, а не про текущую реплику. */
export function asksAboutPastDialogue(text: string): boolean {
  return PAST_RE.test(text);
}

/**
 * Более ранние реплики этого же диалога.
 * Поднимаются, если человек спрашивает про прошлое или слова вопроса есть в старых сообщениях.
 */
export async function recallEarlierTurns(
  chatId: string,
  userId: number | undefined,
  query: string,
): Promise<StaffThreadLine[]> {
  if (!userId) return [];
  const rows = await prisma.dialogueTurn.findMany({
    where: { chatId, userId: String(userId) },
    orderBy: { seq: "desc" },
    take: RECALL_SCAN,
    select: { who: true, text: true },
  });
  const chronological = rows.reverse();
  const older = chronological.slice(0, Math.max(0, chronological.length - PROMPT_LINES));
  if (!older.length) return [];

  const queryTokens = contentTokens(query);
  const aboutPast = asksAboutPastDialogue(query);
  const hits: Array<{ score: number; idx: number }> = [];
  for (let i = 0; i < older.length; i++) {
    if (!queryTokens.length) break;
    const lineTokens = new Set(contentTokens(older[i].text));
    let score = 0;
    for (const token of queryTokens) {
      if (lineTokens.has(token)) score += 1;
    }
    if (score > 0) hits.push({ score, idx: i });
  }

  const picked = new Set<number>();
  if (hits.length) {
    hits.sort((a, b) => b.score - a.score || b.idx - a.idx);
    for (const hit of hits.slice(0, 3)) {
      picked.add(hit.idx);
      if (older[hit.idx]?.who === "rita" && hit.idx > 0) picked.add(hit.idx - 1);
      if (older[hit.idx + 1]) picked.add(hit.idx + 1);
    }
  } else if (aboutPast) {
    const start = Math.max(0, older.length - RECALL_LINES);
    for (let i = start; i < older.length; i++) picked.add(i);
  }

  return [...picked]
    .filter((idx) => idx >= 0 && idx < older.length)
    .sort((a, b) => a - b)
    .slice(-RECALL_LINES)
    .map((idx) => ({
      who: older[idx].who === "rita" ? "rita" : "user",
      text: older[idx].text,
    }));
}
