import { Bot, type CommandContext } from "grammy";
import { env, isAdmin, isBotOwner } from "../env.js";
import { prisma } from "../db/client.js";
import { classify, getClassifyMode } from "../classify/index.js";
import type { Skill } from "../config/types.js";
import {
  formatClientAck,
  formatResolvedNotice,
  formatStatus,
  formatTicketCard,
  parseTicketNumberFromText,
  ticketTag,
} from "../tickets/card.js";
import {
  addLink,
  appendMessage,
  createTicket,
  findTicketByLinkedMessage,
  findTicketByNumber,
  getRecentMessages,
  listOpenTickets,
  pickExecutorChats,
  setTicketStatus,
} from "../tickets/service.js";
import { createWeeekTasksForPeople, isWeeekEnabled } from "../weeek/client.js";
import { detectAddressedPeople, loadWeeekPeople } from "../weeek/people.js";
import { getExecutorChats } from "../config/loadProjects.js";
import { formatClientLabel, isClientSpeaker } from "./clientSpeaker.js";
import { formatDevRelayBrief } from "../relay/devBrief.js";
import {
  generateClientReply,
  type ClientReplyKind,
} from "../clientVoice/generate.js";
import { answerClientQuestion } from "../clientVoice/contextAnswer.js";
import type { BotContext } from "./context.js";
import type { Ticket } from "@prisma/client";
import type { ClassifyResult } from "../classify/types.js";
import { assessClientReport } from "../classify/issueDetail.js";
import { buildDevIssueSummary } from "../classify/issueSummary.js";
import { handleStaffAssistantMessage, mentionsBot } from "./staffAssistant.js";
import { deleteSharedMemory, findMemorySource, forgetMemory, listMemories, listSharedMemory, saveMemory, saveSharedMemory } from "../memory/ritaMemory.js";
import { enqueueUnindexedTurns, processPendingMemory } from "../memory/semanticMemory.js";
import { recallEarlierTurns } from "../staffAssistant/session.js";
import { appendStaffExchange } from "../staffAssistant/session.js";
import { textAddressesRita } from "./ritaAddress.js";
import {
  clearClientRole,
  effectiveClientMessage,
  getClientRole,
  isClientRoleExit,
  isDeferredRoleStart,
  noteClientRole,
  parseClientRolePlay,
  shouldRelayDevToClient,
} from "./clientRolePlay.js";
import { contentManagerMention, isVbrandTeamMember } from "../team/loadTeam.js";
import { greetClient, understandClientRequest, type ClientIntent } from "../classify/clientIntent.js";
import { holdFinanceMessage } from "../finance/hold.js";
import { handleDeveloperReply, observeClientWorkChat } from "../relay/problemEscalation.js";
import { understandClientMedia } from "../media/understand.js";
import {
  deactivateKnowledgeDocument,
  indexKnowledgeDocument,
  KnowledgeDocumentError,
  listKnowledgeDocuments,
  MAX_KNOWLEDGE_FILE_BYTES,
} from "../memory/knowledgeDocuments.js";

function repliesToBot(ctx: BotContext): boolean {
  const from = ctx.message?.reply_to_message?.from;
  if (!from?.is_bot) return false;
  return ctx.me?.id == null || from.id === ctx.me.id;
}

function msgText(ctx: BotContext): string {
  return ctx.message?.text || ctx.message?.caption || "";
}

function hasMedia(ctx: BotContext): boolean {
  const m = ctx.message;
  if (!m) return false;
  return Boolean(m.photo || m.document || m.video || m.voice || m.audio || m.video_note);
}

/** Скрины, фото и файлы документов клиенту в чат разработки не копируем. */
function isClientPhotoOrDocument(ctx: BotContext): boolean {
  const m = ctx.message;
  return Boolean(m?.photo || m?.document);
}

function extractMentions(ctx: BotContext): { userIds: string[]; texts: string[] } {
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
      const name = [e.user.first_name, e.user.last_name].filter(Boolean).join(" ");
      if (name) texts.push(name);
    }
  }
  return { userIds, texts };
}

async function maybeCreateWeeekTasks(
  ctx: BotContext,
  result: ClassifyResult,
  ticketNumber: number | null,
) {
  if (!isWeeekEnabled() || !result.weeek_assignee_keys.length) return;
  const cfg = loadWeeekPeople();
  const people = cfg.people.filter((p) => result.weeek_assignee_keys.includes(p.key));
  if (!people.length) return;

  const title =
    result.weeek_task_title ||
    result.summary ||
    msgText(ctx).slice(0, 200) ||
    "Задача из Telegram";
  const description = [
    result.summary,
    ticketNumber != null ? `Тикет Telegram: #T-${ticketNumber}` : null,
    `Источник: чат ${ctx.chat?.title || ctx.chat?.id}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const created = await createWeeekTasksForPeople({
      title: `[TG] ${title}`.slice(0, 240),
      description,
      people,
    });
    const lines = created.map(
      (c) => `• ${c.person.display_name} — задача Weeek #${c.taskId}`,
    );
    await ctx.reply(`Поставил в Weeek:\n${lines.join("\n")}`);
  } catch (e) {
    console.error("Weeek create failed", e);
    await ctx.reply("Не удалось создать задачу в Weeek (см. логи).");
  }
}

const CLIENT_QUESTION_RE =
  /в чём|в чем|почему|что случилось|что было|объясни|расскажи|как исправили|в чем была/i;

const DEV_UPDATE_RE =
  /\b(готово|решено|исправл|починил|всё\s+исправ|сделал|обновил)/i;

async function buildTicketThread(ticketId: string): Promise<string> {
  const messages = await getRecentMessages(ticketId, 25);
  return messages
    .reverse()
    .map((m) => `${m.direction}: ${m.text}`)
    .join("\n");
}

async function buildClientReply(
  ctx: BotContext,
  projectName: string,
  result: ClassifyResult,
  kind: ClientReplyKind,
  open: Awaited<ReturnType<typeof listOpenTickets>>,
  opts?: { isFollowUp?: boolean; clientCorpus?: string },
): Promise<string> {
  return generateClientReply({
    kind,
    projectName,
    clientText: effectiveClientMessage(ctx, msgText(ctx)),
    summary: result.summary,
    clarifyHint: result.clarify_question,
    orderRef: result.order_ref,
    hasMedia: hasMedia(ctx),
    openTickets: open.map((t) => ({ summary: t.summary, status: t.status })),
    isFollowUp: opts?.isFollowUp,
    clientCorpus: opts?.clientCorpus,
    clientName: getClientRole(ctx)?.persona,
  });
}

async function rememberExchange(
  ctx: BotContext,
  userText: string,
  ritaText: string,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId == null || userId == null || !ritaText.trim()) return;
  await appendStaffExchange(String(chatId), userId, userText, ritaText);
}

/** Реплики в роли клиента не идут через staff-ассистента — сохраняем первый ответ Риты. */
function captureNextRitaReply(ctx: BotContext): void {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId == null || userId == null) return;
  const userText = msgText(ctx);
  const original = ctx.reply.bind(ctx);
  let saved = false;
  ctx.reply = (async (text, other, signal) => {
    const sent = await original(text, other, signal);
    if (!saved && typeof text === "string" && text.trim()) {
      saved = true;
      await appendStaffExchange(String(chatId), userId, userText, text);
    }
    return sent;
  }) as typeof ctx.reply;
}

async function answerBareClientRoleSwitch(ctx: BotContext): Promise<boolean> {
  const parsed = parseClientRolePlay(msgText(ctx));
  if (!parsed.explicit || parsed.clientText) return false;
  const name = parsed.persona || getClientRole(ctx)?.persona;
  const who = name ? `, ${name}` : "";
  await ctx.reply(`Добрый день${who}!\nСлушаю вас.`);
  return true;
}

function mergeTicketClientText(
  ticket: Ticket,
  newText: string,
  orderRef: string | null,
): string {
  return [ticket.summary, newText, orderRef ? `Заказ №${orderRef}` : null]
    .filter(Boolean)
    .join("\n");
}

async function resolveReplyTicket(ctx: BotContext) {
  const info = ctx.projectInfo;
  if (!info || !ctx.message?.reply_to_message) return null;
  const replyId = String(ctx.message.reply_to_message.message_id);
  const chatId = String(ctx.chat!.id);
  const byLink = await findTicketByLinkedMessage(chatId, replyId);
  if (byLink) return byLink;
  const replyText =
    ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || "";
  const num = parseTicketNumberFromText(replyText);
  if (num == null) return null;
  return findTicketByNumber(info.project.id, num);
}

export function registerHandlers(bot: Bot<BotContext>) {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "PM-бот Rita. Пишет от имени «Вика Работа» (стиль из боевых чатов NEW ARMOR).",
        `Режим классификации: ${getClassifyMode()}`,
        "",
        "Админ: /projects · /bind <slug> client|executor",
        "Админ: /ticket <n> · /resolve <n> (внутренний учёт)",
      ].join("\n"),
    );
  });

  bot.command("projects", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply("Только для админов.");
      return;
    }
    const projects = await prisma.project.findMany({ include: { chats: true } });
    if (!projects.length) {
      await ctx.reply("Проектов нет. Добавьте YAML в config/projects и перезапустите.");
      return;
    }
    const lines = projects.map((p) => {
      const chats = p.chats
        .map((c) => `  · ${c.role}/${c.skill} ${c.chatId} ${c.label}`)
        .join("\n");
      return `• ${p.slug} — ${p.name}\n${chats || "  (чаты не привязаны)"}`;
    });
    await ctx.reply(lines.join("\n\n"));
  });

  bot.command("bind", async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply("Только для админов.");
      return;
    }
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("Команду /bind нужно вызвать в групповом чате проекта.");
      return;
    }
    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const [slug, role, skill = "general"] = parts;
    if (!slug || !role || !["client", "executor", "staff"].includes(role)) {
      await ctx.reply("Использование: /bind <project_slug> client|executor|staff");
      return;
    }
    const project = await prisma.project.findUnique({ where: { slug } });
    if (!project) {
      await ctx.reply(`Проект «${slug}» не найден. Проверьте config/projects/*.yaml`);
      return;
    }
    const chatId = String(ctx.chat.id);
    await prisma.$transaction(async (tx) => {
      await tx.chatBindingRevocation.deleteMany({ where: { chatId } });
      await tx.chatBinding.upsert({
        where: { projectId_chatId: { projectId: project.id, chatId } },
        create: {
          projectId: project.id,
          chatId,
          role,
          skill,
          label: ctx.chat.title || "",
        },
        update: { role, skill, label: ctx.chat.title || "" },
      });
    });
    await ctx.reply(
      `Чат привязан к ${slug} как ${role}${skill ? ` / ${skill}` : ""}.\nid: ${chatId}`,
    );
  });

  bot.command("unbind", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid || !isBotOwner(uid)) { await ctx.reply("Only the bot creator can remove project chat bindings."); return; }
    if (ctx.chat?.type !== "private") { await ctx.reply("Use /unbind in a private chat with Rita."); return; }
    const chatId = (ctx.match || "").trim().split(/\s+/, 1)[0];
    if (!/^-?\d+$/.test(chatId)) {
      await ctx.reply("Usage: /unbind <chat_id>. Get the ID from /projects.");
      return;
    }
    const bindings = await prisma.chatBinding.findMany({ where: { chatId }, include: { project: true } });
    if (!bindings.length) {
      const revoked = await prisma.chatBindingRevocation.findUnique({ where: { chatId }, select: { id: true } });
      await ctx.reply(revoked ? `Chat ${chatId} is already unbound.` : `No active project binding for chat ${chatId}.`);
      return;
    }
    await prisma.$transaction(async (tx) => {
      await tx.chatBinding.deleteMany({ where: { chatId } });
      await tx.chatBindingRevocation.upsert({
        where: { chatId },
        create: { chatId, disabledBy: String(uid) },
        update: { disabledBy: String(uid), createdAt: new Date() },
      });
    });
    const removed = bindings.map((binding) => `${binding.project.slug}/${binding.role}`).join(", ");
    await ctx.reply(`Removed ${removed} binding for ${chatId}. Rita is still a member of the Telegram group; only project processing was disabled. Use /bind in that group to bind it again.`);
  });

  bot.command("access", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid || (!isBotOwner(uid) && !isAdmin(uid))) {
      await ctx.reply("Только администратор может управлять доступом к личным сообщениям.");
      return;
    }
    if (ctx.chat?.type !== "private") {
      await ctx.reply("Используйте /access в личном чате с Ритой.");
      return;
    }

    const [action, targetId] = (ctx.match || "").trim().split(/\s+/, 2);
    if (action === "add" || action === "remove") {
      if (!targetId || !/^\d{1,20}$/.test(targetId)) {
        await ctx.reply(`Формат: /access ${action} <telegram_user_id>`);
        return;
      }
      if (isBotOwner(Number(targetId)) || isAdmin(Number(targetId))) {
        await ctx.reply("Этот пользователь уже имеет постоянный административный доступ и не управляется списком.");
        return;
      }
      if (action === "add") {
        const result = await prisma.privateChatAccess.upsert({
          where: { userId: targetId },
          create: { userId: targetId, grantedBy: String(uid), allowed: true },
          update: { grantedBy: String(uid), allowed: true },
        });
        await ctx.reply(`Доступ к личным сообщениям разрешён для Telegram ID ${result.userId}.`);
        return;
      }
      await prisma.privateChatAccess.upsert({
        where: { userId: targetId },
        create: { userId: targetId, grantedBy: String(uid), allowed: false },
        update: { grantedBy: String(uid), allowed: false },
      });
      await ctx.reply(`Доступ к личным сообщениям отозван у Telegram ID ${targetId}.`);
      return;
    }
    if (action === "list") {
      const users = await prisma.privateChatAccess.findMany({ where: { allowed: true }, orderBy: { createdAt: "asc" } });
      await ctx.reply(users.length
        ? ["Пользователи с доступом к личным сообщениям:", ...users.map((user) => `• ${user.userId} (добавил администратор ${user.grantedBy})`)].join("\n")
        : "В списке нет пользователей. Администраторы и участники команды имеют доступ независимо от него.");
      return;
    }
    await ctx.reply("Команды: /access add <telegram_user_id>, /access remove <telegram_user_id>, /access list");
  });

  bot.command("ticket", async (ctx) => {
    await handleTicketLookup(ctx);
  });

  bot.command("resolve", async (ctx) => {
    await handleStatusCommand(ctx, "resolved");
  });

  bot.command("open", async (ctx) => {
    await handleStatusCommand(ctx, "open");
  });

  bot.command("teach", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid || !isBotOwner(uid)) { await ctx.reply("Only the bot creator can change shared memory and Rita's rules."); return; }
    if (ctx.chat?.type !== "private") { await ctx.reply("Use /teach in a private chat with Rita."); return; }
    const [action, ...rest] = (ctx.match || "").trim().split(/\s+/);
    const value = rest.join(" ").trim();
    if (action === "index") {
      const users = await prisma.dialogueTurn.findMany({ distinct: ["userId"], select: { userId: true } });
      let queued = 0;
      for (const user of users) {
        queued += await enqueueUnindexedTurns(user.userId);
        void processPendingMemory(user.userId).catch((error) => console.error("shared memory queue failed", error));
      }
      await ctx.reply(`Queued ${queued} historical turns from ${users.length} staff accounts for shared fact extraction. Remaining history is handled in later batches.`); return;
    }
    if ((action === "allow" || action === "forbid") && value.length >= 4) {
      const id = await saveSharedMemory({ category: action === "allow" ? "creator_allow" : "creator_forbid", content: value, createdBy: String(uid) });
      await ctx.reply(`Saved creator policy (${action}). ID: ${id}. The newest matching policy wins.`); return;
    }
    if (action === "fact" && value.length >= 5) {
      const id = await saveSharedMemory({ category: "fact", content: value, createdBy: String(uid), confidence: 1 });
      await ctx.reply(`Saved fact to shared memory. ID: ${id}`); return;
    }
    if (action === "remove" && value) {
      await ctx.reply(await deleteSharedMemory(value) ? "Removed from shared memory." : "No active shared record with that ID."); return;
    }
    if (action === "list") {
      const items = await listSharedMemory();
      await ctx.reply(items.length ? items.map((m) => `${m.id} [${m.category}] ${m.content}`).join("\n").slice(0, 3800) : "Shared memory is empty."); return;
    }
    await ctx.reply("Commands: /teach allow <what Rita may do>; /teach forbid <what Rita must not do>; /teach fact <shared fact>; /teach index; /teach list; /teach remove <id>");
  });

  bot.command("docs", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid || !isBotOwner(uid)) { await ctx.reply("Only the bot creator can manage shared reference documents."); return; }
    if (ctx.chat?.type !== "private") { await ctx.reply("Use /docs in a private chat with Rita."); return; }
    const [action, id] = (ctx.match || "").trim().split(/\s+/, 2);
    if (action === "list") {
      const docs = await listKnowledgeDocuments();
      await ctx.reply(docs.length
        ? docs.map((doc) => `${doc.id} [${doc.status}; ${doc.chunkCount} chunks] ${doc.title} (${doc.fileName})`).join("\n").slice(0, 3800)
        : "No reference documents yet. Send me a PDF or DOCX in this private chat.");
      return;
    }
    if (action === "remove" && id) {
      await ctx.reply(await deactivateKnowledgeDocument(id) ? "Document removed from search." : "No active document with that ID.");
      return;
    }
    await ctx.reply("Send a PDF or DOCX here to index it. Commands: /docs list; /docs remove <id>.");
  });

  bot.command("memory", async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid || (!isVbrandTeamMember(ctx.from) && !isBotOwner(uid))) return;
    if (ctx.chat?.type !== "private") { await ctx.reply("Use memory commands in a private chat with Rita."); return; }
    const arg = (ctx.match || "").trim();
    const [action, ...rest] = arg.split(/\s+/);
    const chatId = String(ctx.chat.id);
    if (action === "shared") {
      const shared = await listSharedMemory();
      await ctx.reply(shared.length ? shared.map((m) => `${m.id} [${m.category}] ${m.content}`).join("\n").slice(0, 3800) : "Shared memory is empty."); return;
    }
    if (action === "add" && rest.length) {
      await saveMemory(String(uid), null, "rule", rest.join(" ").slice(0, 1000), []);
      await ctx.reply("Saved to your private memory."); return;
    }
    if (action === "delete" && rest[0]) {
      await ctx.reply(await forgetMemory(String(uid), rest[0]) ? "Private memory removed." : "No active private memory with that ID."); return;
    }
    if (action === "source" && rest[0]) {
      const source = await findMemorySource(String(uid), rest[0]);
      if (!source) { await ctx.reply("Memory record not found."); return; }
      const excerpt = source.turns.map((t) => `${t.createdAt.toLocaleString("ru-RU")}: ${t.who === "rita" ? "Rita" : "You"} ? ${t.text}`).join("\n");
      await ctx.reply(excerpt || "No source turns are linked to this record."); return;
    }
    if (action === "search" && rest.length) {
      const hits = await recallEarlierTurns(chatId, uid, rest.join(" "), env.memoryTimezone, true);
      const output = hits.map((h) => `[${h.createdAt?.toLocaleString("ru-RU") ?? "unknown date"}${h.chatId ? `; chat ${h.chatId}` : ""}] ${h.who === "rita" ? "Rita" : "You"}: ${h.text}`).join("\n\n");
      await ctx.reply(output.slice(0, 3800) || "No matching messages were found in your chats."); return;
    }
    if (action === "index") {
      const added = await enqueueUnindexedTurns(String(uid));
      void processPendingMemory(String(uid)).catch((error) => console.error("memory queue failed", error));
      await ctx.reply(`Queued ${added} past messages for semantic indexing. Indexing continues in small batches as you chat with Rita.`); return;
    }
    const [memories, shared] = await Promise.all([listMemories(String(uid), chatId), listSharedMemory()]);
    const output = ["Your private memories:", ...memories.map((m) => `${m.id} [${m.category}] ${m.content}`), "", "Shared team memory:", ...shared.map((m) => `${m.id} [${m.category}] ${m.content}`)].join("\n");
    await ctx.reply(output.slice(0, 3800) || "Memory is empty.");
  });

  bot.on("message", async (ctx) => {
    if (ctx.message?.text?.startsWith("/")) return;

    if (await holdFinanceMessage(ctx)) return;

    const textEarly = msgText(ctx);
    const addressedToRita = mentionsBot(ctx, textEarly) || repliesToBot(ctx);
    if (ctx.projectInfo?.binding.role === "client" && ctx.chat?.type !== "private") {
      if ((await observeClientWorkChat(ctx)) === "hold") return;
    }
    if (ctx.projectInfo?.binding.role === "executor" && ctx.chat?.type !== "private") {
      if ((await handleDeveloperReply(ctx)) === "handled") return;
    }
    if (ctx.chat?.type !== "private" && !addressedToRita) return;

    if (ctx.chat?.type === "private" && ctx.message?.document) {
      const uid = ctx.from?.id;
      if (!uid || !isBotOwner(uid)) {
        await ctx.reply("Shared document uploads are available only to the bot creator.");
        return;
      }
      const file = ctx.message.document;
      if (file.file_size != null && file.file_size > MAX_KNOWLEDGE_FILE_BYTES) {
        await ctx.reply("Файл больше лимита 20 МБ. Отправь документ меньшего размера.");
        return;
      }
      const fileName = file.file_name || (file.mime_type === "application/pdf" ? "document.pdf" : file.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? "document.docx" : "document");
      await ctx.reply("Получила документ. Извлекаю текст и индексирую фрагменты для поиска…");
      try {
        const remote = await ctx.api.getFile(file.file_id);
        if (!remote.file_path) throw new KnowledgeDocumentError("Telegram не вернул путь для скачивания.");
        const indexed = await indexKnowledgeDocument({
          filePath: remote.file_path,
          fileName,
          mimeType: file.mime_type || "application/octet-stream",
          uploadedBy: String(uid),
        });
        await ctx.reply(indexed.alreadyIndexed
          ? `Этот документ уже есть в базе: ${indexed.title} (${indexed.chunkCount} фрагментов).`
          : `Готово: ${indexed.title}. В индекс добавлено ${indexed.chunkCount} фрагментов; документ доступен для поиска во всех рабочих чатах.`);
      } catch (error) {
        if (error instanceof KnowledgeDocumentError) {
          await ctx.reply(error.message);
        } else {
          console.error("knowledge document indexing failed", error);
          await ctx.reply("Не удалось обработать документ. Проверь формат и попробуй ещё раз.");
        }
      }
      return;
    }

    if (ctx.chat?.type === "private" && ctx.privateChatAuthorized && !ctx.projectInfo) {
      if (await handleStaffAssistantMessage(ctx)) return;
      return;
    }

    const info = ctx.projectInfo;
    if (!info) {
      const t = msgText(ctx);
      const allowedOperator = isVbrandTeamMember(ctx.from) || isAdmin(ctx.from?.id);
      if (ctx.chat?.type !== "private" && allowedOperator && t.length > 2 && (mentionsBot(ctx, t) || textAddressesRita(t))) {
        await ctx.reply("В этой группе Rita не обрабатывает сообщения, пока владелец не привяжет её к проекту через /bind.");
      }
      return;
    }

    const relayMode = info.runtime?.mode !== "ticket";
    const staffProject = {
      name: info.project.name,
      slug: info.project.slug,
      bindingRole: info.binding.role as "client" | "executor" | "staff",
    };

    const rolePlay = parseClientRolePlay(textEarly);
    if (
      rolePlay.explicit &&
      rolePlay.clientText &&
      !isDeferredRoleStart(textEarly) &&
      info.binding.role !== "executor"
    ) {
      noteClientRole(ctx, textEarly);
      const heard = await understandClientMedia(ctx);
      const issue = [rolePlay.clientText, heard].filter(Boolean).join("\n");
      const intent = await understandClientRequest(issue);
      const contentTask = intent.kind === "content";
      const mention = contentTask ? contentManagerMention(info.project.slug) : null;
      const executors = info.project.chats.filter((chat) => chat.role === "executor");
      const who = rolePlay.persona ? `, ${rolePlay.persona}` : "";
      if (!executors.length) {
        await ctx.reply(
          `Добрый день${who}!\nПоняла. Чат разработчиков ещё не привязан, поэтому передать пока некуда.`,
        );
        return;
      }
      const ticket = await createTicket({
        project: info.project,
        skill: contentTask ? "general" : "site",
        summary: issue.slice(0, 500),
        orderRef: null,
        clientChatId:
          info.binding.role === "client"
            ? String(ctx.chat!.id)
            : info.project.chats.find((chat) => chat.role === "client")?.chatId || String(ctx.chat!.id),
        openedByUserId: ctx.from?.id != null ? String(ctx.from.id) : null,
        status: "open",
      });
      await appendMessage({
        ticketId: ticket.id,
        direction: "client",
        telegramMessageId: String(ctx.message!.message_id),
        chatId: String(ctx.chat!.id),
        fromUserId: ctx.from?.id != null ? String(ctx.from.id) : null,
        text: issue,
        hasMedia: hasMedia(ctx),
      });
      const body = [
        mention,
        "Добрый день!",
        "",
        contentTask
          ? "Задача контент-менеджера."
          : intent.kind === "advice"
            ? "Нужно согласовать доработку. Рита сама внедрение не решает."
            : null,
        rolePlay.persona ? `Клиент: ${rolePlay.persona}` : "Обращение клиента",
        issue,
        "",
        "↩️ Ответ клиенту уйдёт, только если напишете, что готово, или зададите уточняющий вопрос по этой проблеме.",
      ]
        .filter(Boolean)
        .join("\n");
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
          if (hasMedia(ctx) && ctx.message?.message_id && !isClientPhotoOrDocument(ctx)) {
            await ctx.api.copyMessage(Number(ex.chatId), Number(ctx.chat!.id), ctx.message.message_id);
          }
          sent += 1;
        } catch (e) {
          console.error("roleplay relay failed", ex.chatId, e);
        }
      }
      await ctx.reply(
        sent
          ? greetClient(intent.reply, rolePlay.persona)
          : `Добрый день${who}!\nПоняла задачу, но отправить её не удалось.`,
      );
      return;
    }

    // Внутренний чат сотрудников: не рабочие вопросы, без тикетов и пересылки клиенту.
    if (info.binding.role === "staff") {
      await handleStaffAssistantMessage(ctx, staffProject);
      return;
    }

    if (isDeferredRoleStart(textEarly)) {
      noteClientRole(ctx, textEarly);
      const name = parseClientRolePlay(textEarly).persona;
      const who = name ? ` (${name})` : "";
      const reply = `Хорошо. Со следующего сообщения отвечаю как клиенту${who}. Чтобы снова говорить со мной как с коллегой, напишите «отмена».`;
      await ctx.reply(reply);
      await rememberExchange(ctx, textEarly, reply);
      return;
    }

    if (isClientRoleExit(textEarly)) {
      const hadRole = Boolean(getClientRole(ctx));
      clearClientRole(ctx);
      if (hadRole || /^(?:["«»'\s]*)(?:отмена|стоп)(?:["«»'\s]*)$/iu.test(textEarly.trim())) {
        const reply = "Хорошо. Дальше говорю с тобой как с коллегой, не как с клиентом.";
        await ctx.reply(reply);
        await rememberExchange(ctx, textEarly, reply);
        return;
      }
    }

    const relayDevUpdate =
      staffProject.bindingRole === "executor" &&
      shouldRelayDevToClient(ctx, textEarly);

    if (!relayDevUpdate && (await handleStaffAssistantMessage(ctx, staffProject))) {
      return;
    }

    const activeRole = getClientRole(ctx);
    if (activeRole && !activeRole.pending) captureNextRitaReply(ctx);

    if (await answerBareClientRoleSwitch(ctx)) {
      return;
    }

    if (
      relayMode &&
      info.binding.role === "client" &&
      info.runtime &&
      !isClientSpeaker(ctx, info.runtime)
    ) {
      return;
    }

    let text = effectiveClientMessage(ctx, textEarly);
    const media = hasMedia(ctx);
    if (info.binding.role === "client" && media) {
      const heard = await understandClientMedia(ctx);
      if (heard) text = [text.trim(), heard].filter(Boolean).join("\n");
    }

    const chatId = String(ctx.chat!.id);
    const fromId = ctx.from?.id != null ? String(ctx.from.id) : null;
    const telegramMessageId = String(ctx.message!.message_id);
    let replyTicket = await resolveReplyTicket(ctx);
    const open = await listOpenTickets(info.project.id);
    const collectingTicket =
      info.binding.role === "client"
        ? open.find((t) => t.status === "collecting")
        : undefined;
    if (!replyTicket && collectingTicket) {
      replyTicket = collectingTicket;
    }
    const mentions = extractMentions(ctx);
    const addressed = detectAddressedPeople({
      text,
      mentionUserIds: mentions.userIds,
      mentionTexts: mentions.texts,
    });

    let result = await classify({
      text,
      hasMedia: media,
      chatRole: info.binding.role as "client" | "executor",
      replyTicketNumber: replyTicket?.number ?? null,
      openTickets: open.map((t) => ({
        number: t.number,
        summary: t.summary,
        status: t.status,
      })),
      mentionUserIds: mentions.userIds,
      mentionTexts: mentions.texts,
      addressedKeys: addressed.map((p) => p.key),
    });

    if (
      !replyTicket &&
      result.ticket_id != null &&
      (result.action === "append_ticket" || result.action === "status_signal")
    ) {
      replyTicket = await findTicketByNumber(info.project.id, result.ticket_id);
    }

    // Ответы разработчиков разбирает handleDeveloperReply в начале обработчика:
    // клиенту уходит только «готово» или уточнение по проблеме.

    // Вопрос клиента по открытой теме
    if (
      info.binding.role === "client" &&
      open.length > 0 &&
      CLIENT_QUESTION_RE.test(text)
    ) {
      const ticket = open[0];
      const thread = await buildTicketThread(ticket.id);
      const answer = await answerClientQuestion({
        projectName: info.project.name,
        question: text,
        issueSummary: ticket.summary,
        thread,
      });
      await ctx.reply(answer);
      return;
    }

    // Weeek без TG-тикета (поручение сотруднику)
    if (result.action === "ignore") {
      if (
        mentionsBot(ctx, text) &&
        (isVbrandTeamMember(ctx.from) || isBotOwner(ctx.from?.id))
      ) {
        if (await handleStaffAssistantMessage(ctx, staffProject)) return;
      }
      await maybeCreateWeeekTasks(ctx, result, null);
      return;
    }

    // Reply on existing ticket
    if (
      replyTicket &&
      (result.action === "append_ticket" ||
        result.action === "status_signal" ||
        result.action === "new_ticket" ||
        result.action === "clarify")
    ) {
      await appendMessage({
        ticketId: replyTicket.id,
        direction: info.binding.role === "client" ? "client" : "executor",
        telegramMessageId,
        chatId,
        fromUserId: fromId,
        text,
        hasMedia: media,
      });

      if (result.status_hint === "resolved") {
        const updated = await setTicketStatus(replyTicket.id, "resolved");
        await ctx.reply(`Ок, ${ticketTag(updated.number)} помечен как решённый.`);
        try {
          const notice = relayMode
            ? await generateClientReply({
                kind: "resolved",
                projectName: info.project.name,
                clientText: text,
                summary: updated.summary,
                clarifyHint: null,
                orderRef: updated.orderRef,
                hasMedia: media,
                openTickets: [],
              })
            : formatResolvedNotice(updated);
          await ctx.api.sendMessage(Number(updated.clientChatId), notice);
        } catch (e) {
          console.error("notify client failed", e);
        }
        return;
      }

      if (result.status_hint === "waiting_client") {
        if (info.binding.role === "executor") return;
        await setTicketStatus(replyTicket.id, "waiting_client");
        try {
          await ctx.api.sendMessage(
            Number(replyTicket.clientChatId),
            `По тикету ${ticketTag(replyTicket.number)} нужен ответ клиента.\n${text}`,
          );
        } catch (e) {
          console.error("waiting_client notify failed", e);
        }
        return;
      }

      if (
        replyTicket.status === "collecting" &&
        info.binding.role === "client" &&
        result.action === "clarify"
      ) {
        const q = await buildClientReply(ctx, info.project.name, result, "clarify", open, {
          isFollowUp: true,
          clientCorpus: replyTicket.summary,
        });
        await ctx.reply(relayMode ? q : `${ticketTag(replyTicket.number)}\n${q}`);
        return;
      }

      // Promote collecting → open and route after client clarified
      if (
        replyTicket.status === "collecting" &&
        info.binding.role === "client" &&
        result.action !== "clarify"
      ) {
        const orderRef = result.order_ref || replyTicket.orderRef;
        const merged = mergeTicketClientText(replyTicket, text, orderRef);
        const skill = (result.skill || replyTicket.skill) as Skill;
        const detail = assessClientReport({
          text: merged,
          hasMedia: media,
          orderRef,
          skill,
        });

        if (!detail.readyForDev) {
          await prisma.ticket.update({
            where: { id: replyTicket.id },
            data: {
              summary: merged.slice(0, 500),
              orderRef,
              skill,
            },
          });
          const clarifyResult: ClassifyResult = {
            ...result,
            action: "clarify",
            summary: merged.slice(0, 500),
            order_ref: orderRef,
            clarify_question: detail.clarifyQuestion,
            clarify_target: "client",
          };
          const q = await buildClientReply(
            ctx,
            info.project.name,
            clarifyResult,
            "clarify",
            open,
            { isFollowUp: true, clientCorpus: merged },
          );
          await ctx.reply(relayMode ? q : `${ticketTag(replyTicket.number)}\n${q}`);
          return;
        }

        const devSummary = buildDevIssueSummary(merged);
        const opened = await prisma.ticket.update({
          where: { id: replyTicket.id },
          data: {
            status: "open",
            summary: devSummary,
            orderRef,
            skill,
            executorChatIds: JSON.stringify(
              pickExecutorChats(info.project, skill).map((c) => c.chatId),
            ),
          },
        });
        const routeResult: ClassifyResult = {
          ...result,
          summary: devSummary,
          order_ref: orderRef,
          skill,
        };
        if (relayMode) {
          const intent = await understandClientRequest(merged);
          await relayToDevelopers(ctx, info.project, routeResult, opened, chatId, intent);
          await ctx.reply(greetClient(intent.reply, getClientRole(ctx)?.persona));
        } else {
          await routeToExecutors(ctx, info.project.name, info.project, opened);
          await ctx.reply(formatClientAck(opened));
        }
        return;
      }

      if (info.binding.role === "client" && relayMode && result.action === "append_ticket") {
        const merged = mergeTicketClientText(
          replyTicket,
          text,
          result.order_ref || replyTicket.orderRef,
        );
        const supplement = buildDevIssueSummary(merged);
        for (const ex of getExecutorChats(info.project)) {
          try {
            const sent = await ctx.api.sendMessage(Number(ex.chatId), supplement);
            await addLink({
              ticketId: replyTicket.id,
              chatId: ex.chatId,
              telegramMessageId: String(sent.message_id),
              kind: "relay",
            });
            if (media && ctx.message?.message_id && !isClientPhotoOrDocument(ctx)) {
              await ctx.api.copyMessage(Number(ex.chatId), Number(chatId), ctx.message.message_id);
            }
          } catch (e) {
            console.error("relay append failed", e);
          }
        }
        const intent = await understandClientRequest(text);
        await ctx.reply(greetClient(intent.reply, getClientRole(ctx)?.persona));
      }
      return;
    }

    // Only create/clarify from client chat (or collecting flow)
    if (info.binding.role !== "client" && result.action !== "clarify") {
      return;
    }

    if (result.action === "clarify") {
      let ticket = collectingTicket ?? replyTicket;
      if (!ticket) {
        ticket = await createTicket({
          project: info.project,
          skill: result.skill,
          summary: result.summary || text || "Уточнение",
          orderRef: result.order_ref,
          clientChatId: chatId,
          openedByUserId: fromId,
          status: "collecting",
        });
      } else {
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            summary: (result.summary || ticket.summary).slice(0, 500),
            orderRef: result.order_ref || ticket.orderRef,
            skill: result.skill || ticket.skill,
          },
        });
      }
      await appendMessage({
        ticketId: ticket.id,
        direction: "client",
        telegramMessageId,
        chatId,
        fromUserId: fromId,
        text,
        hasMedia: media,
      });
      const q = await buildClientReply(ctx, info.project.name, result, "clarify", open);
      const sent = await ctx.reply(relayMode ? q : `${ticketTag(ticket.number)}\n${q}`);
      await addLink({
        ticketId: ticket.id,
        chatId,
        telegramMessageId: String(sent.message_id),
        kind: "clarify",
      });
      return;
    }

    if (result.action === "new_ticket" || result.action === "append_ticket") {
      let ticket = replyTicket ?? collectingTicket ?? null;
      if (!ticket && result.action === "new_ticket") {
        ticket = await createTicket({
          project: info.project,
          skill: result.skill,
          summary: result.summary,
          orderRef: result.order_ref,
          clientChatId: chatId,
          openedByUserId: fromId,
          status: "open",
        });
      } else if (ticket && ticket.status === "collecting") {
        const merged = mergeTicketClientText(
          ticket,
          text,
          result.order_ref || ticket.orderRef,
        );
        const skill = (result.skill || ticket.skill) as Skill;
        const detail = assessClientReport({
          text: merged,
          hasMedia: media,
          orderRef: result.order_ref || ticket.orderRef,
          skill,
        });
        if (!detail.readyForDev) {
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: { summary: merged.slice(0, 500), status: "collecting" },
          });
          await appendMessage({
            ticketId: ticket.id,
            direction: "client",
            telegramMessageId,
            chatId,
            fromUserId: fromId,
            text,
            hasMedia: media,
          });
          const clarifyResult: ClassifyResult = {
            ...result,
            action: "clarify",
            clarify_question: detail.clarifyQuestion,
          };
          await ctx.reply(
            await buildClientReply(ctx, info.project.name, clarifyResult, "clarify", open, {
              isFollowUp: true,
              clientCorpus: merged,
            }),
          );
          return;
        }
        ticket = await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            status: "open",
            summary: buildDevIssueSummary(merged),
            orderRef: result.order_ref || ticket.orderRef,
            skill,
            executorChatIds: JSON.stringify(
              pickExecutorChats(info.project, skill).map((c) => c.chatId),
            ),
          },
        });
        result = {
          ...result,
          summary: buildDevIssueSummary(merged),
          skill,
        };
      }

      if (!ticket) return;

      await appendMessage({
        ticketId: ticket.id,
        direction: "client",
        telegramMessageId,
        chatId,
        fromUserId: fromId,
        text,
        hasMedia: media,
      });

      const intent = relayMode ? await understandClientRequest(`${result.summary}\n${text}`) : null;
      const ackText = intent
        ? greetClient(intent.reply, getClientRole(ctx)?.persona)
        : formatClientAck(ticket);
      const ack = await ctx.reply(ackText);
      await addLink({
        ticketId: ticket.id,
        chatId,
        telegramMessageId: String(ack.message_id),
        kind: "client_ack",
      });

      if (relayMode) {
        await relayToDevelopers(ctx, info.project, result, ticket, chatId, intent);
      } else {
        await routeToExecutors(ctx, info.project.name, info.project, ticket);
      }
      await maybeCreateWeeekTasks(ctx, result, relayMode ? null : ticket.number);
    }
  });
}

async function relayToDevelopers(
  ctx: BotContext,
  project: { name: string; slug?: string; chats: Array<{ role: string; chatId: string }> },
  result: ClassifyResult,
  ticket: Ticket,
  sourceChatId: string,
  knownIntent?: ClientIntent | null,
) {
  const devChats = getExecutorChats(project);
  if (!devChats.length) {
    await ctx.reply("Нет чата разработчиков. Админ: /bind newarmor executor");
    return;
  }

  const clientThread = await buildTicketThread(ticket.id);

  const brief = await formatDevRelayBrief({
    projectName: project.name,
    clientLabel: formatClientLabel(ctx),
    summary: result.summary,
    originalText: effectiveClientMessage(ctx, msgText(ctx)),
    hasMedia: hasMedia(ctx),
    skill: result.skill as Skill,
    orderRef: result.order_ref,
    clientThread,
  });

  const relayText = `${result.summary}\n${effectiveClientMessage(ctx, msgText(ctx))}`;
  const intent = knownIntent ?? (await understandClientRequest(relayText));
  const contentMention = intent.kind === "content" ? contentManagerMention(project.slug) : null;
  const intentLabel =
    intent.kind === "content"
      ? "Задача контент-менеджера."
      : intent.kind === "advice"
        ? "Нужно согласовать доработку. Рита сама внедрение не решает."
        : null;
  const devMessage = [
    contentMention,
    intentLabel,
    brief,
    "↩️ Клиенту перешлю только ответ, что готово, или уточняющий вопрос по этой проблеме. Остальное не пересылаю.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messageId = ctx.message?.message_id;
  for (const ex of devChats) {
    try {
      const sent = await ctx.api.sendMessage(Number(ex.chatId), devMessage);
      await addLink({
        ticketId: ticket.id,
        chatId: ex.chatId,
        telegramMessageId: String(sent.message_id),
        kind: "relay",
      });
      if (messageId && hasMedia(ctx) && !isClientPhotoOrDocument(ctx)) {
        await ctx.api.copyMessage(Number(ex.chatId), Number(sourceChatId), messageId);
      }
    } catch (e) {
      console.error("relay to dev failed", ex.chatId, e);
    }
  }
}

async function routeToExecutors(
  ctx: BotContext,
  projectName: string,
  project: Parameters<typeof pickExecutorChats>[0],
  ticket: Ticket,
) {
  const list = pickExecutorChats(project, ticket.skill as Skill);
  if (!list.length) {
    await ctx.reply(
      "Нет привязанных чатов исполнителей. Админ: /bind <slug> executor <skill>",
    );
    return;
  }
  const card = formatTicketCard(ticket, projectName);
  for (const ex of list) {
    try {
      const sent = await ctx.api.sendMessage(Number(ex.chatId), card);
      await addLink({
        ticketId: ticket.id,
        chatId: ex.chatId,
        telegramMessageId: String(sent.message_id),
        kind: "card",
      });
    } catch (e) {
      console.error("route to executor failed", ex.chatId, e);
    }
  }
}

async function handleTicketLookup(ctx: CommandContext<BotContext>) {
  const info = ctx.projectInfo;
  if (!info) {
    await ctx.reply("Этот чат не привязан к проекту.");
    return;
  }
  const n = Number((ctx.match || "").trim());
  if (!n) {
    await ctx.reply("Использование: /ticket <номер>");
    return;
  }
  const ticket = await findTicketByNumber(info.project.id, n);
  if (!ticket) {
    await ctx.reply("Тикет не найден.");
    return;
  }
  const recent = await getRecentMessages(ticket.id, 5);
  const hist = recent
    .reverse()
    .map((m) => `· [${m.direction}] ${m.text.slice(0, 120)}`)
    .join("\n");
  await ctx.reply(
    [formatStatus(ticket), "", "Последние сообщения:", hist || "—"].join("\n"),
  );
}

async function handleStatusCommand(
  ctx: CommandContext<BotContext>,
  status: "resolved" | "open",
) {
  const info = ctx.projectInfo;
  if (!info) {
    await ctx.reply("Этот чат не привязан к проекту.");
    return;
  }
  const n = Number((ctx.match || "").trim());
  if (!n) {
    await ctx.reply(`Использование: /${status === "resolved" ? "resolve" : "open"} <номер>`);
    return;
  }
  const ticket = await findTicketByNumber(info.project.id, n);
  if (!ticket) {
    await ctx.reply("Тикет не найден.");
    return;
  }
  const updated = await setTicketStatus(ticket.id, status);
  await ctx.reply(formatStatus(updated));
  if (status === "resolved") {
    const relayMode = info.runtime?.mode !== "ticket";
    try {
      await ctx.api.sendMessage(
        Number(updated.clientChatId),
        relayMode
          ? await generateClientReply({
              kind: "resolved",
              projectName: info.project.name,
              clientText: "",
              summary: updated.summary,
              clarifyHint: null,
              orderRef: updated.orderRef,
              hasMedia: false,
              openTickets: [],
            })
          : formatResolvedNotice(updated),
      );
    } catch (e) {
      console.error("resolve notify failed", e);
    }
  }
}
