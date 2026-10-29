import { isBotOwner } from "../env.js";
import type { BotContext } from "./context.js";
import { isContentCatalogTask } from "../classify/contentTask.js";
import { shouldTryStaffWeeek } from "../staffAssistant/weeekFromStaff.js";
import { textAddressesRita } from "./ritaAddress.js";

const CLIENT_SIM_RE =
  /(?:пишу\s+)?от\s+(?:лица|роли)\s+клиента|как\s+клиент|имитирую\s+клиента|от\s+роли\s+клиента|пишу\s+от\s+роли|будто\s+я\s+клиент/i;

const ROLE_CUE_RE =
  /(?:от\s+лица(?:\s+клиента|\s*\(|\s+[A-Za-zА-Яа-яЁё])|от\s+роли(?:\s+клиента|\s+[A-Za-zА-Яа-яЁё])|(?:говорю|пишу)\s+от\s+роли|будто\s+я(?:\s+клиент|\s+[A-Za-zА-Яа-яЁё])|как\s+будто\s+я|в\s+роли(?:\s+клиента|\s+[A-Za-zА-Яа-яЁё])|я\s+сейчас\s+(?:говорю\s+)?(?:как\s+)?клиент|(?:воспринимай|считай)\s+меня\s+(?:как\s+)?клиент|играю\s+клиент|(?:говори|ответь|отвечай)\s+(?:мне\s+)?(?:сейчас\s+)?(?:будто|как)\s+(?:я|с\s+клиент))/iu;

const ROLE_EXIT_RE =
  /(?:хватит\s+рол|я\s+(?:уже\s+)?не\s+клиент|снова\s+как\s+(?:сотрудник|коллег)|выйди\s+из\s+роли|не\s+будто\s+я|это\s+снова\s+я)/iu;

const ROLE_RECALL_RE =
  /помнишь|кто\s+я(?:\s+сейчас)?|говорил\s+от\s+лица|говорил\s+как\s+клиент/iu;

const NEXT_MESSAGE_RE = /со\s+следующ/iu;

const TELL_CLIENT_RE =
  /ответь(?:те)?\s+клиенту|скажи(?:те)?\s+клиенту|напиши(?:те)?\s+клиенту|говори(?:ть)?\s+клиенту|сама\s+в\s+чате|в\s+чате\s*\(?\s*клиент/iu;

const STAFF_META_RE =
  /сформулиру|помоги.*(?:клиент|текст)|как\s+написать\s+клиент|что\s+ответить\s+клиент|вот\s+текст\s+для\s+клиента/i;

const WEEEK_STAFF_RE = /(?:wee?ek|\bweek\b|задач.*week|week.*задач)/i;

const ROLE_TTL_MS = 25 * 60 * 1000;

interface ClientRoleState {
  expiresAt: number;
  persona: string | null;
  clientText: string | null;
  /** Включится со следующего сообщения, это ещё не реплика клиента. */
  pending: boolean;
}

const roles = new Map<string, ClientRoleState>();

function roleKey(ctx: BotContext): string | null {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId == null || userId == null) return null;
  return `${chatId}:${userId}`;
}

export interface ParsedClientRole {
  explicit: boolean;
  persona: string | null;
  /** Текст проблемы после вводной. null — только просьба войти в роль. */
  clientText: string | null;
}

function normalizePersona(raw: string): string | null {
  const name = raw.replace(/[()«»"]/g, "").trim();
  if (!name || /^клиент/i.test(name)) return null;
  if (/ия$/i.test(name)) return name.replace(/ия$/i, "ий");
  return name;
}

const VITALY_LINE_RE =
  /(?:^|\n)\s*(?:(?:рита|рит|маргарита)[,!]?\s*)?виталий\s*[:：]\s*([\s\S]+)/iu;

export function isClientRoleCue(text: string): boolean {
  if (VITALY_LINE_RE.test(text)) return true;
  if (
    ROLE_RECALL_RE.test(text) &&
    !/(?:со\s+следующ|воспринимай\s+меня\s+как\s+клиент)/iu.test(text)
  ) {
    return false;
  }
  return ROLE_CUE_RE.test(text) || CLIENT_SIM_RE.test(text);
}

export function isClientRoleExit(text: string): boolean {
  const bare = text.trim().replace(/^["«»'\s]+|["«»'\s]+$/g, "");
  if (/^(?:отмена|стоп)$/iu.test(bare)) return true;
  return ROLE_EXIT_RE.test(text);
}

/** «Со следующего сообщения» — роль ещё не началась. */
export function isDeferredRoleStart(text: string): boolean {
  return NEXT_MESSAGE_RE.test(text) && isClientRoleCue(text);
}

/** Reply на карточку для разработчиков или просьба самому ответить клиенту. */
export function shouldRelayDevToClient(ctx: BotContext, text: string): boolean {
  const reply =
    ctx.message?.reply_to_message?.text || ctx.message?.reply_to_message?.caption || "";
  if (/переписка с клиентом|перешлю клиенту|ответьте reply/i.test(reply)) return true;
  return TELL_CLIENT_RE.test(text);
}

export function clearClientRole(ctx: BotContext): void {
  const key = roleKey(ctx);
  if (key) roles.delete(key);
}

export function parseClientRolePlay(text: string): ParsedClientRole {
  const vitaly = text.match(VITALY_LINE_RE);
  const vitalyText = vitaly?.[1]?.trim();
  if (vitalyText) {
    return { explicit: true, persona: "Виталий", clientText: vitalyText };
  }

  const explicit = isClientRoleCue(text);
  if (!explicit) return { explicit: false, persona: null, clientText: null };

  const paren = text.match(/\(\s*([A-Za-zА-Яа-яЁё-]{2,})\s*\)/);
  const named = text.match(
    /(?:от\s+лица|будто\s+я|как\s+будто\s+я|в\s+роли|от\s+роли)\s*\(?\s*([A-Za-zА-Яа-яЁё-]{2,})/iu,
  );
  const persona =
    (paren?.[1] && normalizePersona(paren[1])) ||
    (named?.[1] ? normalizePersona(named[1]) : null);

  const chunks = text.split(/\n\s*\n/);
  if (chunks.length >= 2) {
    const body = chunks.slice(1).join("\n\n").trim();
    if (body) return { explicit: true, persona, clientText: body };
  }

  const afterName = text.match(
    /(?:от\s+лица|будто\s+я|как\s+будто\s+я|в\s+роли|от\s+роли)\s*\(?\s*(?!клиент\b)[A-Za-zА-Яа-яЁё-]{2,}\)?\s*[:：]\s*([\s\S]+)/iu,
  );
  const namedTail = afterName?.[1]?.trim();
  if (namedTail) return { explicit: true, persona, clientText: namedTail };

  const colon = text.match(
    /(?:будто\s+я\s+клиент|я\s+клиент|от\s+лица\s+клиента)\s*[:：]\s*([\s\S]+)/i,
  );
  const tail = colon?.[1]?.trim();
  if (tail) return { explicit: true, persona, clientText: tail };

  return { explicit: true, persona, clientText: null };
}

export function getClientRole(ctx: BotContext): ClientRoleState | null {
  const key = roleKey(ctx);
  if (!key) return null;
  const state = roles.get(key);
  if (!state || Date.now() > state.expiresAt) {
    if (key) roles.delete(key);
    return null;
  }
  return state;
}

function mentionsSomeoneElse(ctx: BotContext, text: string): boolean {
  if (textAddressesRita(text)) return false;
  const bot = ctx.me?.username?.toLowerCase();
  const msg = ctx.message;
  const entities = [...(msg?.entities || []), ...(msg?.caption_entities || [])];
  const raw = msg?.text || msg?.caption || text;
  for (const e of entities) {
    if (e.type !== "mention") continue;
    const name = raw.slice(e.offset, e.offset + e.length).replace(/^@/, "").toLowerCase();
    if (name && name !== bot) return true;
  }
  return false;
}

function isReplyToBot(ctx: BotContext): boolean {
  const from = ctx.message?.reply_to_message?.from;
  if (!from?.is_bot) return false;
  return ctx.me?.id == null || from.id === ctx.me.id;
}

function isRoleContinuation(ctx: BotContext, text: string): boolean {
  if (!getClientRole(ctx)) return false;
  if (isClientRoleExit(text) || isStaffWeeekRequest(text)) return false;
  if (isStaffMetaRequest(text) && !isClientRoleCue(text)) return false;
  if (mentionsSomeoneElse(ctx, text)) return false;
  if (ctx.chat?.type === "private") return true;
  if (isReplyToBot(ctx) || textAddressesRita(text)) return true;
  return false;
}

/** Запоминает роль «я клиент» и возвращает её, если это реплика в роли. */
export function noteClientRole(ctx: BotContext, text: string): ClientRoleState | null {
  const key = roleKey(ctx);
  if (!key) return null;
  if (isClientRoleExit(text)) {
    roles.delete(key);
    return null;
  }
  if (isStaffWeeekRequest(text)) return null;
  if (isStaffMetaRequest(text) && !isClientRoleCue(text)) return null;

  const parsed = parseClientRolePlay(text);
  const prev = getClientRole(ctx);
  if (prev?.pending) {
    const state: ClientRoleState = {
      expiresAt: Date.now() + ROLE_TTL_MS,
      persona: prev.persona,
      clientText: text.trim() || prev.clientText,
      pending: false,
    };
    roles.set(key, state);
    return state;
  }
  if (isDeferredRoleStart(text)) {
    roles.set(key, {
      expiresAt: Date.now() + ROLE_TTL_MS,
      persona: parsed.persona,
      clientText: null,
      pending: true,
    });
    return null;
  }
  if (parsed.explicit) {
    const state: ClientRoleState = {
      expiresAt: Date.now() + ROLE_TTL_MS,
      persona: parsed.persona || prev?.persona || null,
      clientText: parsed.clientText || prev?.clientText || null,
      pending: false,
    };
    roles.set(key, state);
    return state;
  }
  if (prev && !prev.pending && isRoleContinuation(ctx, text)) {
    const state: ClientRoleState = {
      ...prev,
      expiresAt: Date.now() + ROLE_TTL_MS,
      clientText: text.trim() || prev.clientText,
      pending: false,
    };
    roles.set(key, state);
    return state;
  }
  return null;
}

export function extractClientSimulationText(text: string): string | null {
  return parseClientRolePlay(text).clientText;
}

export function isStaffMetaRequest(text: string): boolean {
  return STAFF_META_RE.test(text);
}

export function isStaffWeeekRequest(text: string, _thread = ""): boolean {
  return shouldTryStaffWeeek(text);
}

export function isClientSimulationForBot(ctx: BotContext, text: string): boolean {
  if (isClientRoleExit(text) || isDeferredRoleStart(text)) return false;
  if (isStaffMetaRequest(text) && !isClientRoleCue(text)) return false;
  if (isStaffWeeekRequest(text)) return false;
  if (isClientRoleCue(text)) return true;
  const role = getClientRole(ctx);
  if (!role || role.pending) return false;
  if (!isReplyToBot(ctx) && !textAddressesRita(text)) return false;
  const simulated = extractClientSimulationText(text);
  if (simulated) return true;
  if (isContentCatalogTask(simulated || text)) return true;
  if (/не\s+работает|не\s+робит|не\s+запуска|лёг\s+сайт|сайт\s+не|ошибк/i.test(text)) {
    return true;
  }
  return false;
}

export function shouldSkipStaffForClientTest(ctx: BotContext, text: string): boolean {
  if (isClientRoleExit(text) || isDeferredRoleStart(text)) {
    if (isClientRoleExit(text)) clearClientRole(ctx);
    return false;
  }
  if (isStaffWeeekRequest(text)) return false;
  if (isStaffMetaRequest(text) && !isClientRoleCue(text)) return false;
  if (noteClientRole(ctx, text)) return true;
  if (isClientSimulationForBot(ctx, text)) return true;
  if (isOwnerClientTestMessage(ctx, text)) return true;
  return false;
}

export function isOwnerClientTestMessage(ctx: BotContext, text: string): boolean {
  if (!isBotOwner(ctx.from?.id)) return false;
  if (isClientRoleExit(text) || isDeferredRoleStart(text)) return false;
  if (isStaffWeeekRequest(text)) return false;
  if (isClientRoleCue(text)) return true;
  if (isRoleContinuation(ctx, text)) return true;
  if (textAddressesRita(text)) return false;
  if (isStaffMetaRequest(text)) return false;
  if (CLIENT_SIM_RE.test(text)) return true;
  if (isContentCatalogTask(text) && !WEEEK_STAFF_RE.test(text)) return true;
  return false;
}

export function effectiveClientMessage(_ctx: BotContext, text: string): string {
  return parseClientRolePlay(text).clientText ?? text;
}
