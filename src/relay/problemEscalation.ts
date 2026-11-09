import type { Bot } from "grammy";
import { prisma } from "../db/client.js";
import { env } from "../env.js";
import type { Skill } from "../config/types.js";
import { isContentCatalogTask, isClientEvidenceMessage } from "../classify/contentTask.js";
import { assessClientReport, buildClientClarifyQuestion } from "../classify/issueDetail.js";
import { extractOrderRef } from "../classify/orderRef.js";
import { generateClientReply } from "../clientVoice/generate.js";
import { addLink, appendMessage, createTicket, findTicketByLinkedMessage, listOpenTickets, setTicketStatus } from "../tickets/service.js";
import { loadTeamConfig } from "../team/loadTeam.js";
import { formatClientLabel, isClientSpeaker } from "../bot/clientSpeaker.js";
import { textAddressesRita } from "../bot/ritaAddress.js";
import type { BotContext } from "../bot/context.js";

export const PROBLEM_WAIT_MS = 5 * 60 * 1000;

const PROBLEM_RE =
  /не\s+работает|не\s+робит|ошибк|баг|слома|не\s+открыва|не\s+груз|не\s+запуск|упал|недоступ|не\s+заходит|не\s+приходит|не\s+могу|помогите|проблема|вылетел|зависа|не\s+подтяг|расхожд/iu;

const ADVICE_RE =
  /плюс|минус|что\s+(?:вы\s+)?дума|свой\s+взгляд|проработ|стоит\s+ли|подключ|посовет|как\s+лучше|имеет\s+смысл|оцените|мнение/iu;

const RESOLVED_RE =
  /исправили|исправлено|исправлена|исправлен\b|починил[иа]?|починено|решено|решили|можно\s+проверять|(?:^|[\s,!.])готово(?:[\s.!]|$)/iu;

const STILL_WORKING_RE =
  /будем\s+проверя|проверяем|сообщ\w*|как\s+исправим|когда\s+исправим|исправим|исправите|взяли\s+в\s+работу|в\s+работе|смотрим|разбираемся|будет\s+готово|когда\s+(?:будет\s+)?готово|ещё\s+не|пока\s+не|гляну|посмотрю/iu;

const ASKS_CLIENT_RE =
  /\?|уточни|уточните|подскаж|какой|какая|какие|какое|сколько|где\b|когда\b|почему|номер|скрин|пришлите|пришли|скинь|что\s+именно/iu;

const INTERNAL_RE =
  /лог(?:и|ах)|на\s+сервере|в\s+коде|деплой|коммит|не\s+пересылай|клиенту\s+не\b/iu;

const ACK_RE =
  /^(?:ок|окей|ага|угу|спасибо|принял[аи]?|понял[аи]?|гляну|посмотрю|смотрим)[.!?\s]*$/iu;

export type DevRelayDecision = "resolved" | "clarify" | "ask_admin" | "ignore";

export function isClientProblem(text: string, hasMedia: boolean): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (isContentCatalogTask(t)) return false;
  if (ADVICE_RE.test(t) && !PROBLEM_RE.test(t)) return false;
  if (PROBLEM_RE.test(t)) return true;
  return hasMedia && isClientEvidenceMessage(t, true);
}

export function devSaysResolved(text: string): boolean {
  if (STILL_WORKING_RE.test(text) && !RESOLVED_RE.test(text)) return false;
  return RESOLVED_RE.test(text);
}

export function isClarifyingQuestion(text: string): boolean {
  if (/спроси(?:те)?\s+(?:у\s+)?клиент|уточни(?:те)?\s+у\s+клиент/iu.test(text)) return true;
  if (INTERNAL_RE.test(text)) return false;
  return ASKS_CLIENT_RE.test(text);
}

export function classifyDevReply(text: string, tiedToProblem: boolean): DevRelayDecision {
  if (devSaysResolved(text)) return "resolved";
  if (!tiedToProblem) return "ignore";
  if (isClarifyingQuestion(text)) return "clarify";
  if (ACK_RE.test(text.trim()) || STILL_WORKING_RE.test(text) || INTERNAL_RE.test(text)) return "ignore";
  if (text.trim().length >= 12) return "ask_admin";
  return "ignore";
}

function guessSkill(text: string): Skill {
  if (/юкасс|yookassa|оплат|эквайр/i.test(text)) return "payment";
  if (/остат|склад|1\s*[сc]|синхрон/i.test(text)) return "onec";
  return "site";
}

const SCREEN_ONLY = "(скрин проблемы без текста)";

/** Текст клиенту в момент передачи разработчикам: вопрос, если сути нет, иначе — что задача ушла в разработку. */
export function clientNoticeForEscalation(text: string, hasMedia: boolean): string {
  const raw = text === SCREEN_ONLY ? "" : text.trim();
  const skill = guessSkill(raw);
  const orderRef = extractOrderRef(raw);
  const assessment = assessClientReport({ text: raw, hasMedia, orderRef, skill });
  const mediaWithoutStory = hasMedia && raw.length < 20;
  if (!assessment.readyForDev || mediaWithoutStory) {
    if (assessment.clarifyQuestion) return assessment.clarifyQuestion;
    if (mediaWithoutStory) {
      return "Добрый день!\n\nУвидела скрин. Подскажите, пожалуйста, что именно не так?";
    }
    return buildClientClarifyQuestion(skill, raw, orderRef);
  }
  return "Добрый день!\nПриняли. Задачу передала в отдел разработки — как будет готово, напишем.";
}

function parseIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((id) => Number(id)).filter((id) => Number.isFinite(id));
  } catch {
    return [];
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function adminMentionsHtml(): string {
  const ids = [...new Set([...env.adminUserIds, ...env.botOwnerUserIds])];
  const people = loadTeamConfig().people;
  return ids
    .map((id) => {
      const person = people.find((item) => item.telegram_user_id === id);
      if (person?.telegram_username) return `@${person.telegram_username}`;
      const name = escapeHtml(person?.display_name || "администратор");
      return `<a href="tg://user?id=${id}">${name}</a>`;
    })
    .join(" ");
}

/**
 * Клиентская проблема не уходит разработчикам сразу.
 * «hold» — ждём 5 минут, ответит ли кто-то из людей. Клиенту Рита пишет уже при передаче.
 */
export async function observeClientWorkChat(ctx: BotContext): Promise<"hold" | "continue"> {
  const info = ctx.projectInfo;
  if (!info?.runtime || info.binding.role !== "client") return "continue";
  if (ctx.chat?.type === "private" || !ctx.chat || !ctx.message || !ctx.from || ctx.from.is_bot) return "continue";

  const text = ctx.message.text || ctx.message.caption || "";
  const media = Boolean(ctx.message.photo || ctx.message.document || ctx.message.video);
  const chatId = String(ctx.chat.id);

  if (!isClientSpeaker(ctx, info.runtime)) {
    await prisma.problemEscalation.updateMany({
      where: { clientChatId: chatId, status: "pending" },
      data: { status: "answered" },
    });
    return "continue";
  }

  if (!isClientProblem(text, media)) return "continue";

  const fromUserId = String(ctx.from.id);
  const pending = await prisma.problemEscalation.findFirst({
    where: { clientChatId: chatId, fromUserId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  const ids = pending ? parseIds(pending.messageIds) : [];
  ids.push(ctx.message.message_id);
  const nextText = [pending?.text, text.trim()].filter(Boolean).join("\n").slice(0, 4000);
  const data = {
    text: nextText || "(скрин проблемы без текста)",
    messageIds: JSON.stringify(ids),
    hasMedia: Boolean(pending?.hasMedia || media),
    escalateAt: new Date(Date.now() + PROBLEM_WAIT_MS),
    clientLabel: formatClientLabel(ctx),
  };
  if (pending) {
    await prisma.problemEscalation.update({ where: { id: pending.id }, data });
  } else {
    await prisma.problemEscalation.create({
      data: {
        projectId: info.project.id,
        clientChatId: chatId,
        fromUserId,
        ...data,
      },
    });
  }
  return "hold";
}

export async function handleDeveloperReply(ctx: BotContext): Promise<"handled" | "skip"> {
  const info = ctx.projectInfo;
  if (!info || info.binding.role !== "executor" || !ctx.chat || !ctx.message || !ctx.from || ctx.from.is_bot) {
    return "skip";
  }
  const text = (ctx.message.text || ctx.message.caption || "").trim();
  if (!text && !ctx.message.photo && !ctx.message.document) return "skip";
  if (textAddressesRita(text) && !devSaysResolved(text) && !isClarifyingQuestion(text)) return "skip";

  const chatId = String(ctx.chat.id);
  const replyId = ctx.message.reply_to_message ? String(ctx.message.reply_to_message.message_id) : null;
  const linked = replyId ? await findTicketByLinkedMessage(chatId, replyId) : null;
  const open = linked ? [] : await listOpenTickets(info.project.id);
  const ticket = linked ?? (open.length === 1 && devSaysResolved(text) ? open[0] : null);
  if (!ticket) return "skip";

  let decision = classifyDevReply(text, Boolean(linked) || ticket === open[0]);
  const hasMedia = Boolean(ctx.message.photo || ctx.message.document || ctx.message.video);
  if (decision === "ignore" && linked && hasMedia) decision = "ask_admin";
  if (decision === "ignore") return linked ? "handled" : "skip";

  await appendMessage({
    ticketId: ticket.id,
    direction: "executor",
    telegramMessageId: String(ctx.message.message_id),
    chatId,
    fromUserId: String(ctx.from.id),
    text,
    hasMedia,
  });

  if (decision === "ask_admin") {
    const mentions = adminMentionsHtml();
    const note = `${mentions} это не сообщение, что готово, и не уточнение по проблеме. Клиенту не пересылаю — решите, пожалуйста, что делать дальше.`.trim();
    try {
      await ctx.reply(note, { parse_mode: "HTML" });
    } catch (error) {
      console.error("admin mention failed", error);
      await ctx.reply(
        "Это не сообщение, что готово, и не уточнение по проблеме. Клиенту не пересылаю — нужно решение администратора.",
      );
    }
    return "handled";
  }

  if (decision === "resolved") {
    const updated = await setTicketStatus(ticket.id, "resolved", text);
    const notice = await generateClientReply({
      kind: "resolved",
      projectName: info.project.name,
      clientText: text,
      summary: `${updated.summary}\n${text}`,
      clarifyHint: null,
      orderRef: updated.orderRef,
      hasMedia: Boolean(ctx.message.photo || ctx.message.document),
      openTickets: [],
    });
    await ctx.api.sendMessage(Number(updated.clientChatId), notice);
    if (ctx.message.photo || ctx.message.document || ctx.message.video) {
      await ctx.api.copyMessage(Number(updated.clientChatId), ctx.chat.id, ctx.message.message_id);
    }
    await ctx.reply("Передала клиенту: написали, что готово.");
    return "handled";
  }

  await setTicketStatus(ticket.id, "waiting_client");
  await ctx.api.sendMessage(
    Number(ticket.clientChatId),
    `Добрый день!\nПо проблеме нужно уточнение:\n${text}`,
  );
  if (ctx.message.photo || ctx.message.document || ctx.message.video) {
    await ctx.api.copyMessage(Number(ticket.clientChatId), ctx.chat.id, ctx.message.message_id);
  }
  await ctx.reply("Передала клиенту только уточняющий вопрос по этой проблеме.");
  return "handled";
}

async function forwardDue(bot: Bot<BotContext>, id: string): Promise<void> {
  const claimed = await prisma.problemEscalation.updateMany({
    where: { id, status: "pending", escalateAt: { lte: new Date() } },
    data: { status: "forwarding" },
  });
  if (claimed.count !== 1) return;

  const row = await prisma.problemEscalation.findUnique({ where: { id } });
  if (!row) return;
  const project = await prisma.project.findUnique({
    where: { id: row.projectId },
    include: { chats: true },
  });
  const executors = project?.chats.filter((chat) => chat.role === "executor") ?? [];
  if (!project || !executors.length) {
    await prisma.problemEscalation.update({ where: { id }, data: { status: "failed" } });
    console.error("problem escalation: нет чата разработчиков", row.projectId);
    return;
  }

  try {
    const ticket = await createTicket({
      project,
      skill: guessSkill(row.text),
      summary: row.text.slice(0, 500),
      orderRef: null,
      clientChatId: row.clientChatId,
      openedByUserId: row.fromUserId,
      status: "open",
    });
    await appendMessage({
      ticketId: ticket.id,
      direction: "client",
      telegramMessageId: String(parseIds(row.messageIds)[0] ?? Date.now()),
      chatId: row.clientChatId,
      fromUserId: row.fromUserId,
      text: row.text,
      hasMedia: row.hasMedia,
    });
    const body = [
      "Я бот Рита. Это автоматическая пересылка.",
      "",
      `Проект: ${project.name}`,
      "",
      row.text,
      "",
      "Клиенту я перешлю только ответ, что готово или исправлено, либо уточняющий вопрос по этой проблеме. Остальное не пересылаю.",
    ].join("\n");

    for (const chat of executors) {
      const sent = await bot.api.sendMessage(Number(chat.chatId), body);
      await addLink({
        ticketId: ticket.id,
        chatId: chat.chatId,
        telegramMessageId: String(sent.message_id),
        kind: "relay",
      });
      for (const messageId of parseIds(row.messageIds)) {
        try {
          await bot.api.copyMessage(Number(chat.chatId), Number(row.clientChatId), messageId);
        } catch (error) {
          console.error("problem escalation copy failed", chat.chatId, messageId, error);
        }
      }
    }
    try {
      await bot.api.sendMessage(
        Number(row.clientChatId),
        clientNoticeForEscalation(row.text, row.hasMedia),
      );
    } catch (error) {
      console.error("problem escalation client notice failed", row.clientChatId, error);
    }
    await prisma.problemEscalation.update({
      where: { id },
      data: { status: "forwarded", ticketId: ticket.id },
    });
  } catch (error) {
    console.error("problem escalation failed", id, error);
    await prisma.problemEscalation.update({
      where: { id },
      data: { status: "pending", escalateAt: new Date(Date.now() + 60_000) },
    });
  }
}

export function startProblemEscalationLoop(bot: Bot<BotContext>): void {
  const tick = async () => {
    const due = await prisma.problemEscalation.findMany({
      where: { status: "pending", escalateAt: { lte: new Date() } },
      select: { id: true },
      take: 20,
    });
    for (const row of due) {
      await forwardDue(bot, row.id);
    }
  };
  void tick().catch((error) => console.error("problem escalation loop failed", error));
  setInterval(() => {
    void tick().catch((error) => console.error("problem escalation loop failed", error));
  }, 15_000);
}
