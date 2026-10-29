import { prisma } from "../db/client.js";

const LEARN_RE =
  /запомни|в\s+следующ(?:ий|ем)\s+раз|больше\s+не|не\s+надо\s+было|нужно\s+было|не\s+так|ты\s+не\s+(?:передала|поняла|сделала|сообщила)/iu;

const STATUS_ASK_RE =
  /какой\s+статус|что\s+со\s+статус|какие\s+проблем|что\s+в\s+работе|что\s+(?:уже\s+)?решил|статус\s+(?:ошиб|задач|обращен)/iu;

const STATUS_LABEL: Record<string, string> = {
  collecting: "уточняем у клиента",
  open: "передано разработчикам",
  in_progress: "в работе",
  waiting_client: "ждём клиента",
  waiting_executor: "ждём разработчиков",
  resolved: "решено",
  cancelled: "отменено",
};

export function asksForProblemStatus(text: string): boolean {
  return STATUS_ASK_RE.test(text);
}

export function lessonTextFrom(text: string): string | null {
  if (!LEARN_RE.test(text)) return null;
  const cleaned = text.replace(/^(?:рита|рит|маргарита)[,!]?\s*/i, "").trim();
  if (cleaned.length < 8) return null;
  return cleaned.slice(0, 500);
}

export async function rememberLesson(text: string, chatId?: string): Promise<boolean> {
  const lesson = lessonTextFrom(text);
  if (!lesson) return false;
  const existing = await prisma.lesson.findFirst({ where: { text: lesson } });
  if (existing) return true;
  await prisma.lesson.create({ data: { text: lesson, chatId: chatId ?? null } });
  return true;
}

export async function formatLessonsForPrompt(): Promise<string> {
  const rows = await prisma.lesson.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (!rows.length) return "";
  return rows
    .reverse()
    .map((row) => `• ${row.text}`)
    .join("\n");
}

export async function touchDialogueSummary(
  chatId: string,
  userId: string,
  userText: string,
  ritaText: string,
): Promise<void> {
  const line = `Коллега: ${userText.replace(/\s+/g, " ").slice(0, 180)}\nРита: ${ritaText.replace(/\s+/g, " ").slice(0, 180)}`;
  const prev = await prisma.dialogueSummary.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });
  const summary = [prev?.summary, line].filter(Boolean).join("\n").split("\n").slice(-16).join("\n");
  await prisma.dialogueSummary.upsert({
    where: { chatId_userId: { chatId, userId } },
    create: { chatId, userId, summary },
    update: { summary },
  });
}

export async function getDialogueSummary(chatId: string, userId: string): Promise<string> {
  const row = await prisma.dialogueSummary.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });
  return row?.summary ?? "";
}

export async function formatProblemStatus(projectId: string): Promise<string> {
  const tickets = await prisma.ticket.findMany({
    where: { projectId },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  if (!tickets.length) return "Открытых обращений пока нет.";
  return tickets
    .map((ticket) => {
      const label = STATUS_LABEL[ticket.status] || ticket.status;
      const tail = ticket.resolution ? `\n  Итог: ${ticket.resolution}` : "";
      return `• ${label}: ${ticket.summary.slice(0, 220)}${tail}`;
    })
    .join("\n");
}
