import type { BotContext } from "./context.js";
import { textAddressesRita, textMentionsBotUsername } from "./ritaAddress.js";
import { shouldSkipStaffForClientTest } from "./clientRolePlay.js";
import { env, isBotOwner } from "../env.js";
import { formatTeamDirectory, isVbrandTeamMember, resolveTeamMember } from "../team/loadTeam.js";
import { generateStaffAssistantReply } from "../staffAssistant/reply.js";
import { replyInTelegramParts, withTyping } from "./telegramReply.js";
import { tryCreateWeeekFromStaffRequest } from "../staffAssistant/weeekFromStaff.js";
import {
  appendStaffExchange,
  getStaffTurns,
  recallEarlierTurns,
  saveStaffUserTurn,
  type StaffThreadLine,
} from "../staffAssistant/session.js";
import { understandMessageMedia } from "../media/understand.js";
import { getProjectByChatId } from "../config/loadProjects.js";
import { addLink, appendMessage, createTicket } from "../tickets/service.js";
import {
  asksForProblemStatus,
  formatProblemStatus,
  getDialogueSummary,
  formatMemoriesForPrompt,
  formatSharedKnowledgeForPrompt,
  formatCreatorPoliciesForPrompt,
  creatorForbids,
  parseCreatorPolicyInstruction,
  saveSharedMemory,
  lessonTextFrom,
} from "../memory/ritaMemory.js";
import { formatRelevantLessonsForPrompt } from "../memory/experienceLearning.js";
import { formatDocumentKnowledgeForPrompt } from "../memory/knowledgeDocuments.js";

const QUIET_REQUEST_RE =
  /не\s+(?:нужно|надо)\s+отвеч|не\s+отвечай|не\s+на\s+кажд|каждое\s+(?:мо[её]\s+)?сообщен|когда\s+(?:оно|сообщение)\s+не\s+тебе/iu;

const FAMILY_JOKE_RE =
  /(?:тво[яюей]\s+фамили|фамили[яю]\s*(?:у\s+тебя|тво[яю])|какая\s+(?:у\s+тебя\s+)?фамили|как\s+(?:твоя\s+)?фамили|кто\s+(?:твой|тебя)\s+(?:отец|папа)|твой\s+(?:отец|папа)|кто\s+тебя\s+родил)/iu;

const FAMILY_JOKE_REPLY = "Ткачева) Отец — Станислав Ткачев.";

const STAFF_MESSAGE_GROUP_MS = 2_000;
const STAFF_MESSAGE_LIMIT_PER_MINUTE = 12;
const STAFF_RATE_NOTICE_COOLDOWN_MS = 60_000;
const pendingStaffMessages = new Map<string, { texts: string[]; flushed: Promise<void>; release: () => void }>();
const staffMessageTimestamps = new Map<string, number[]>();
const staffRateNoticeAt = new Map<string, number>();

function takeStaffMessageAllowance(userId: number, now = Date.now()): boolean {
  const key = String(userId);
  const recent = (staffMessageTimestamps.get(key) ?? []).filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= STAFF_MESSAGE_LIMIT_PER_MINUTE) {
    staffMessageTimestamps.set(key, recent);
    return false;
  }
  recent.push(now);
  staffMessageTimestamps.set(key, recent);
  return true;
}

async function groupNearbyStaffMessages(ctx: BotContext, text: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId == null || userId == null || !text.trim() || text.startsWith("/")) return true;
  const key = `${chatId}:${userId}`;
  const existing = pendingStaffMessages.get(key);
  if (existing) {
    existing.texts.push(text.trim().slice(0, 4000));
    await existing.flushed;
    return false;
  }

  let release!: () => void;
  const flushed = new Promise<void>((resolve) => { release = resolve; });
  const batch = { texts: [text.trim().slice(0, 4000)], flushed, release };
  pendingStaffMessages.set(key, batch);
  await new Promise((resolve) => setTimeout(resolve, STAFF_MESSAGE_GROUP_MS));
  if (pendingStaffMessages.get(key) === batch) pendingStaffMessages.delete(key);
  const combined = batch.texts.join("\n").slice(0, 6000);
  if (batch.texts.length > 1 && ctx.message && "text" in ctx.message) {
    (ctx.message as { text?: string }).text = combined;
  }
  batch.release();
  return true;
}

function rateLimitNoticeIsDue(userId: number, now = Date.now()): boolean {
  const key = String(userId);
  const last = staffRateNoticeAt.get(key) ?? 0;
  if (now - last < STAFF_RATE_NOTICE_COOLDOWN_MS) return false;
  staffRateNoticeAt.set(key, now);
  return true;
}

const TEAM_LIST_RE =
  /(?:список|покажи|перечисли|назови).{0,48}сотрудник|сотрудник\w*.{0,24}v[\s-]?brand|состав\s+команд|вся\s+команда|кто\s+(?:у\s+нас\s+)?в\s+команде/iu;

const FORWARD_TO_DEV_RE =
  /переда\w{0,8}[\s\S]{0,90}(?:разработ|групп|туда|ошибк)|(?:нужно|надо).{0,50}групп[\s\S]{0,50}разработ/iu;

const IMPLEMENTATION_RE =
  /(?:проработ|подключ|внедр|доработ|апгрейд|upgrade)/iu;

function isImplementationRequest(text: string): boolean {
  if (/ошибк|не\s+работает|баг|не\s+открыва/i.test(text) && !/плюс|минус|взгляд|проработ/i.test(text)) {
    return false;
  }
  return IMPLEMENTATION_RE.test(text) && /сайт|функц|оплат|сбп|плюс|минус|взгляд/i.test(text);
}

const ISSUE_RE = /ошибк|остат|1\s*[сc]|не\s+подтяг|не\s+обнов|не\s+работ/i;
const FORWARD_META_RE = /переда\w+|привязал|групп\w*\s+разработ|можешь передавать|ты не передала/i;

function issueSentence(raw: string): string | null {
  const parts = raw
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const hit = [...parts].reverse().find((part) => ISSUE_RE.test(part) && !FORWARD_META_RE.test(part));
  if (!hit) return null;
  return hit.replace(/^(?:рита|рит)[,!]?\s*/i, "").trim();
}

function issueFromDialogue(
  text: string,
  replyText: string,
  history: StaffThreadLine[],
): string | null {
  const fromReply = issueSentence(replyText);
  if (fromReply) return fromReply;
  for (const line of [...history].reverse()) {
    if (line.who !== "user") continue;
    const found = issueSentence(line.text);
    if (found) return found;
  }
  return issueSentence(text);
}

async function tryForwardIssueToDevelopers(
  ctx: BotContext,
  text: string,
  replyText: string,
  history: StaffThreadLine[],
  userId?: number,
): Promise<string | null> {
  if (!FORWARD_TO_DEV_RE.test(text)) return null;
  if (await creatorForbids("forward")) return "A creator-set policy currently blocks forwarding this message.";
  const chatId = ctx.chat?.id;
  if (chatId == null) return null;

  const info = await getProjectByChatId(String(chatId));
  if (!info) return "Этот чат не привязан к проекту, передать некуда.";

  const executors = info.project.chats.filter(
    (chat) => chat.role === "executor" && chat.chatId !== String(chatId),
  );
  if (!executors.length) {
    return "Чат разработчиков ещё не привязан. В той группе напишите: /bind newarmor executor";
  }

  const issue = issueFromDialogue(text, replyText, history);
  if (!issue) {
    return "Не вижу текст ошибки в этом диалоге. Напишите, что передать разработчикам.";
  }

  const clientChat = info.project.chats.find((chat) => chat.role === "client");
  const ticket = await createTicket({
    project: info.project,
    skill: "onec",
    summary: issue.slice(0, 500),
    orderRef: null,
    clientChatId: clientChat?.chatId || String(chatId),
    openedByUserId: userId != null ? String(userId) : null,
    status: "open",
  });
  await appendMessage({
    ticketId: ticket.id,
    direction: "client",
    telegramMessageId: String(ctx.message?.message_id || Date.now()),
    chatId: String(chatId),
    fromUserId: userId != null ? String(userId) : null,
    text: issue,
    hasMedia: false,
  });

  const body = [
    "Добрый день!",
    "",
    issue,
    "",
    "↩️ Клиенту перешлю только ответ, что готово, или уточняющий вопрос по этой проблеме.",
  ].join(
    "\n",
  );
  const sentLabels: string[] = [];
  for (const ex of executors) {
    try {
      const sent = await ctx.api.sendMessage(Number(ex.chatId), body);
      await addLink({
        ticketId: ticket.id,
        chatId: ex.chatId,
        telegramMessageId: String(sent.message_id),
        kind: "relay",
      });
      sentLabels.push(ex.label || "чат разработчиков");
    } catch (e) {
      console.error("forward to dev failed", ex.chatId, e);
    }
  }
  if (!sentLabels.length) {
    return "Не удалось отправить в чат разработчиков. Проверьте, что я состою в той группе.";
  }
  return `Передала в ${sentLabels.join(", ")}.`;
}

async function forwardImplementationForApproval(
  ctx: BotContext,
  text: string,
  userId?: number,
): Promise<"sent" | "failed" | "missing" | "here"> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return "missing";
  const info = await getProjectByChatId(String(chatId));
  if (!info) return "missing";
  if (info.binding.role === "executor") return "here";
  const executors = info.project.chats.filter(
    (chat) => chat.role === "executor" && chat.chatId !== String(chatId),
  );
  if (!executors.length) return "missing";

  const ask = text.replace(/^(?:рита|рит|маргарита)[,!]?\s*/i, "").trim();
  const from = ctx.from?.first_name || ctx.from?.username || "сотрудник";
  const ticket = await createTicket({
    project: info.project,
    skill: "site",
    summary: ask.slice(0, 500),
    orderRef: null,
    clientChatId: String(chatId),
    openedByUserId: userId != null ? String(userId) : null,
    status: "open",
  });
  await appendMessage({
    ticketId: ticket.id,
    direction: "client",
    telegramMessageId: String(ctx.message?.message_id || Date.now()),
    chatId: String(chatId),
    fromUserId: userId != null ? String(userId) : null,
    text: ask,
    hasMedia: false,
  });
  const body = [
    "Добрый день!",
    "",
    "Нужно согласовать доработку. Рита сама решение о внедрении не принимает.",
    `От: ${from}`,
    ask,
    "",
    "↩️ Ответьте reply на это сообщение — перешлю обратно.",
  ].join("\n");
  let sent = 0;
  for (const ex of executors) {
    try {
      const message = await ctx.api.sendMessage(Number(ex.chatId), body);
      await addLink({
        ticketId: ticket.id,
        chatId: ex.chatId,
        telegramMessageId: String(message.message_id),
        kind: "relay",
      });
      sent += 1;
    } catch (e) {
      console.error("implementation forward failed", ex.chatId, e);
    }
  }
  return sent ? "sent" : "failed";
}

function withApprovalLine(
  reply: string,
  handoff: "sent" | "failed" | "missing" | "here" | null,
): string {
  if (handoff === "sent" && !/разработчик/i.test(reply)) {
    return `${reply}\n\nСама внедрение не решаю — передала вопрос разработчикам на согласование.`;
  }
  if (handoff === "missing") {
    return `${reply}\n\nЧат разработчиков не привязан, поэтому на согласование передать пока некуда.`;
  }
  return reply;
}

function isReplyToBot(ctx: BotContext): boolean {
  const reply = ctx.message?.reply_to_message;
  if (!reply?.from?.is_bot) return false;
  const me = ctx.me?.id;
  return me != null && reply.from.id === me;
}

function isReplyToOtherPerson(ctx: BotContext): boolean {
  const reply = ctx.message?.reply_to_message;
  if (!reply?.from || reply.from.is_bot) return false;
  const me = ctx.me?.id;
  return reply.from.id !== me;
}

export function mentionsBot(ctx: BotContext, text?: string): boolean {
  const msg = ctx.message;
  if (!msg) return false;
  const raw = text ?? msg.text ?? msg.caption ?? "";
  const botUser = ctx.me?.username?.toLowerCase();
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  for (const e of entities) {
    if (e.type === "mention" && botUser) {
      const slice = raw.slice(e.offset, e.offset + e.length).toLowerCase();
      if (slice === `@${botUser}`) return true;
    }
    if (e.type === "text_mention" && ctx.me?.id && e.user?.id === ctx.me.id) {
      return true;
    }
  }
  return textAddressesRita(raw) || textMentionsBotUsername(raw, botUser);
}

export function isDirectStaffAddress(ctx: BotContext, text?: string): boolean {
  if (ctx.chat?.type === "private") return true;
  return isReplyToBot(ctx) || mentionsBot(ctx, text);
}

function isAddressedToSomeoneElse(ctx: BotContext, text: string): boolean {
  if (isReplyToBot(ctx) || mentionsBot(ctx, text) || textAddressesRita(text)) return false;
  if (isReplyToOtherPerson(ctx)) return true;
  const msg = ctx.message;
  if (!msg) return false;
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const raw = msg.text || msg.caption || "";
  const botUser = ctx.me?.username?.toLowerCase();
  for (const e of entities) {
    if (e.type === "mention") {
      const name = raw.slice(e.offset, e.offset + e.length).replace(/^@/, "").toLowerCase();
      if (name && name !== botUser) return true;
    } else if (e.type === "text_mention" && e.user && e.user.id !== ctx.me?.id) {
      return true;
    }
  }
  return false;
}

export function wantsStaffAssistant(ctx: BotContext, text: string): boolean {
  const from = ctx.from;
  if (!from) return false;
  if (!isVbrandTeamMember(from) && !isBotOwner(from.id) && !ctx.privateChatAuthorized) return false;
  if (!text.trim()) return false;
  if (shouldSkipStaffForClientTest(ctx, text)) return false;

  if (ctx.chat?.type !== "private" && isAddressedToSomeoneElse(ctx, text)) {
    return false;
  }

  if (!isDirectStaffAddress(ctx, text)) return false;

  return true;
}

function extractMentionsForWeeek(ctx: BotContext): {
  userIds: string[];
  texts: string[];
} {
  const msg = ctx.message;
  if (!msg) return { userIds: [], texts: [] };
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const raw = msg.text || msg.caption || "";
  const userIds: string[] = [];
  const texts: string[] = [];
  for (const e of entities) {
    if (e.type === "mention") {
      texts.push(raw.slice(e.offset, e.offset + e.length).replace(/^@/, ""));
    } else if (e.type === "text_mention" && e.user) {
      userIds.push(String(e.user.id));
      if (e.user.username) texts.push(e.user.username);
    }
  }
  return { userIds, texts };
}

export async function handleStaffAssistantMessage(
  ctx: BotContext,
  project?: {
    name: string;
    slug: string;
    bindingRole?: "client" | "executor" | "staff";
  },
): Promise<boolean> {
  let text = ctx.message?.text || ctx.message?.caption || "";
  if (!wantsStaffAssistant(ctx, text)) return false;
  const userId = ctx.from?.id;
  if (userId != null && !takeStaffMessageAllowance(userId)) {
    if (rateLimitNoticeIsDue(userId)) await ctx.reply("Слишком много сообщений подряд. Объедини запросы или подожди минуту — тогда я продолжу.");
    return true;
  }
  if (ctx.message && "text" in ctx.message && !await groupNearbyStaffMessages(ctx, text)) return true;
  text = ctx.message?.text || ctx.message?.caption || text;

  const member = resolveTeamMember(ctx.from) || (ctx.chat?.type === "private" && ctx.privateChatAuthorized && ctx.from && !isBotOwner(ctx.from.id)
    ? {
        key: `authorized_${ctx.from.id}`,
        display_name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "Пользователь",
        role: "other" as const,
        role_label: "пользователь с доступом к личному чату",
        telegram_user_id: String(ctx.from.id),
        telegram_username: ctx.from.username?.toLowerCase() || null,
        aliases: [],
        project_roles: {},
      }
    : null);
  const chatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;

  if (chatId && userId) {
    try {
      const inserted = await saveStaffUserTurn(chatId, userId, text, ctx.update.update_id);
      if (!inserted) return true;
    } catch (e) {
      console.error("incoming dialogue save failed", e);
      await ctx.reply("Не смогла сохранить сообщение в историю, поэтому пока не отвечаю. Попробуй ещё раз позже.");
      return true;
    }
  }

  let userText = text;
  const sendReply = async (reply: string) => {
    await replyInTelegramParts(ctx, reply);
    if (chatId && userId) await appendStaffExchange(chatId, userId, userText, reply, ctx.update.update_id);
  };

  if (userId && isBotOwner(userId) && ctx.chat?.type === "private") {
    const policy = parseCreatorPolicyInstruction(text);
    if (policy) {
      await saveSharedMemory({ ...policy, createdBy: String(userId) });
      await sendReply("Creator rule saved. It will apply to future replies; use /teach list to review rules.");
      return true;
    }
  }

  const history = chatId && userId ? await getStaffTurns(chatId, userId, ctx.update.update_id) : [];
  const earlier =
    chatId && userId ? await recallEarlierTurns(chatId, userId, text, env.memoryTimezone) : [];
  const thread = history.map((l) => `${l.who}: ${l.text}`).join("\n");
  const mentions = extractMentionsForWeeek(ctx);
  const replyText =
    ctx.message?.reply_to_message?.text || ctx.message?.reply_to_message?.caption || "";

  if (QUIET_REQUEST_RE.test(text)) {
    await sendReply(
      "Хорошо. В группе отвечаю, только когда пишут мне: «Рита», reply или @бот.",
    );
    return true;
  }

  if (FAMILY_JOKE_RE.test(text)) {
    await sendReply(FAMILY_JOKE_REPLY);
    return true;
  }

  if (TEAM_LIST_RE.test(text)) {
    await sendReply(formatTeamDirectory());
    return true;
  }

  if (chatId && asksForProblemStatus(text)) {
    const info = await getProjectByChatId(chatId);
    await sendReply(
      info
        ? await formatProblemStatus(info.project.id)
        : "Этот чат не привязан к проекту, статусы обращений мне отсюда не видны.",
    );
    return true;
  }

  if (lessonTextFrom(text) && /запомни|в\s+следующ/iu.test(text) && !FORWARD_TO_DEV_RE.test(text)) {
    await sendReply("Запомнила. Буду учитывать это дальше.");
    return true;
  }

  const forwarded = await tryForwardIssueToDevelopers(ctx, text, replyText, history, userId);
  if (forwarded) {
    await sendReply(forwarded);
    return true;
  }

  if (userId) {
    const weeekReply = await tryCreateWeeekFromStaffRequest({
      text,
      thread,
      replyText,
      fromUserId: userId,
      mentionUserIds: mentions.userIds,
      mentionTexts: mentions.texts,
      projectName: project?.name,
    });
    if (weeekReply) {
      await sendReply(weeekReply);
      return true;
    }
  }

  if (
    project?.bindingRole === "client" &&
    /(?:уже\s+)?(?:мы\s+)?(?:и\s+)?(?:тут\s+)?(?:в\s+)?клиентск/i.test(text)
  ) {
    await sendReply(
      "Да, этот чат привязан как client-чат проекта. Могу ответить клиенту (как Вика) или поставить задачу в Weeek — напишите суть или «поставь мне задачу в Weeek …».",
    );
    return true;
  }

  const heard =
    (await understandMessageMedia(ctx.message)) ||
    (await understandMessageMedia(ctx.message?.reply_to_message));
  if (heard) userText = [text.trim(), heard].filter(Boolean).join("\n");

  const projectInfo = chatId ? await getProjectByChatId(chatId) : null;
  const implementationRequested = isImplementationRequest(userText);
  const implementationBlocked = implementationRequested && await creatorForbids("implementation");
  const handoff = implementationRequested && !implementationBlocked
    ? await forwardImplementationForApproval(ctx, userText, userId)
    : null;
  const handoffNote = implementationBlocked
      ? "A creator-set policy blocks forwarding implementation requests. Do not claim the request was sent."
      : handoff === "sent"
      ? "Сообщение уже отправлено в чат разработчиков на согласование. Скажи это прямо: сама внедрение не решаешь. Если в ссылке sbp.nspk.ru — это СБП, говори про оплату СБП, не про абстрактную «функцию». Не пиши «обсужу с командой»."
      : handoff === "here"
        ? "Это уже чат разработчиков. Скажи, что решение о внедрении за ними. Не пиши, что переслала сообщение в другой чат."
      : handoff === "failed" || handoff === "missing"
        ? "Передать вопрос разработчикам не удалось. Не пиши, что уже отправила его в группу разработки."
        : "";
  if (implementationBlocked) {
    await sendReply("A creator-set policy currently blocks this implementation handoff.");
    return true;
  }
  const memory = {
    dialogueSummary: chatId && userId ? await getDialogueSummary(chatId, String(userId)) : "",
    lessons: userId ? await formatRelevantLessonsForPrompt(String(userId), userText) : "",
    longTerm: chatId && userId ? await formatMemoriesForPrompt(String(userId), chatId) : "",
    sharedKnowledge: await formatSharedKnowledgeForPrompt(userText),
    documentKnowledge: await formatDocumentKnowledgeForPrompt(userText),
    creatorPolicies: await formatCreatorPoliciesForPrompt(),
    problemStatus: projectInfo ? await formatProblemStatus(projectInfo.project.id) : "",
  };

  if (!member && isBotOwner(ctx.from?.id)) {
    const stub = {
      key: "owner",
      display_name: ctx.from?.first_name || "Владелец",
      role: "boss" as const,
      role_label: "владелец бота",
      telegram_user_id: String(ctx.from!.id),
      telegram_username: ctx.from?.username?.toLowerCase() || null,
      project_roles: {},
      aliases: [],
    };
    await withTyping(ctx, async () => {
      const reply = await generateStaffAssistantReply({
        member: stub,
        text: userText,
        chatType: ctx.chat?.type || "private",
        chatTitle: ctx.chat?.title,
        projectName: project?.name,
        projectSlug: project?.slug,
        chatRole: project?.bindingRole,
        conversationHistory: history,
        earlierDialogue: earlier,
        dialogueSummary: memory.dialogueSummary,
        lessons: memory.lessons,
        longTermMemory: memory.longTerm,
        sharedKnowledge: memory.sharedKnowledge,
        documentKnowledge: memory.documentKnowledge,
        creatorPolicies: memory.creatorPolicies,
        problemStatus: memory.problemStatus,
        handoffNote,
      });
      await sendReply(withApprovalLine(reply, handoff));
    });
    return true;
  }

  if (!member) {
    if (mentionsBot(ctx, text) || textAddressesRita(text) || isReplyToBot(ctx)) {
      await ctx.reply(
        "Я вас слышу, но вас нет в config/vbrand-team.yaml — попросите админа добавить telegram_user_id или username, и смогу нормально помогать.",
      );
      return true;
    }
    console.warn(
      "staff assistant: сотрудник не в vbrand-team.yaml",
      ctx.from?.id,
      ctx.from?.username,
    );
    return false;
  }

  await withTyping(ctx, async () => {
    const reply = await generateStaffAssistantReply({
      member,
      text: userText,
      chatType: ctx.chat?.type || "private",
      chatTitle: ctx.chat?.title,
      projectName: project?.name,
      projectSlug: project?.slug,
      chatRole: project?.bindingRole,
      conversationHistory: history,
      earlierDialogue: earlier,
      dialogueSummary: memory.dialogueSummary,
      lessons: memory.lessons,
      longTermMemory: memory.longTerm,
      sharedKnowledge: memory.sharedKnowledge,
      documentKnowledge: memory.documentKnowledge,
      creatorPolicies: memory.creatorPolicies,
      problemStatus: memory.problemStatus,
      handoffNote,
    });
    await sendReply(withApprovalLine(reply, handoff));
  });
  return true;
}
