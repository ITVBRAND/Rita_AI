import type { Api } from "grammy";
import type { BotContext } from "../bot/context.js";
import { loadTeamConfig, type TeamMember } from "../team/loadTeam.js";

/** Финансы агентства разбирают только эти люди, в личке. */
export const FINANCE_CONTACT_KEYS = ["victoria", "pavel", "stas"] as const;

const ORDER_OR_CHECKOUT =
  /заказ|юкасс|yookassa|эквайр|корзин|покупател|checkout|личн(?:ый|ого)\s+кабинет|оформлен(?:ие|ия)\s+заказ|сбп|sbp\.nspk/iu;

const CHECKOUT_BUG =
  /(?:не\s+(?:работает|проходит|открыва|могу)|ошибк|баг|сломал\w*).{0,50}(?:оплат|юкасс|эквайр)|(?:оплат|юкасс|эквайр).{0,50}(?:не\s+(?:работает|проходит)|ошибк|баг|не\s+могу)/iu;

/** Счета, платёжки, акты, долги — не путать с поломкой оплаты на сайте. */
const FINANCE_DOC =
  /плат[её]жк|плат[её]жн(?:ое|ого|ый)\s+поручен|инвойс|\binvoice\b|закрывающ|\bупд\b|бухгалт|реквизит|задолжен|\bфинанс|предоплат|постоплат|безнал|\bндс\b|акт(?:а|у|ом|е)?\s+(?:выполнен|сверк|оказан|сдач|при[её]м)|сч[её]т(?!чик)(?:\s+на\s+оплату|\s*№|[_\s-]*№|\s*n\b|\s+от\b|\s+за\b|[^\n]{0,40}\.(?:pdf|docx?|xlsx?|png|jpe?g))|выстав\w{0,6}\s+сч[её]т|пришл\w{0,6}\s+сч[её]т|оплат\w{0,8}\s+сч[её]т|наш\s+сч[её]т|ваш\s+сч[её]т|сч[её]т\s+на\s+оплату|оплат\w+\s+по\s+договор|договор\w{0,6}\s+.{0,24}оплат|расч[её]тн\w+\s+сч[её]т/iu;

const MONEY_MOVE =
  /перевели\s+(?:деньги|оплату|средства)|(?:деньги|средства)\s+(?:пришли|не\s+пришли|поступили)|поступила\s+оплата|оплатили(?!\s+заказ)/iu;

const FORWARD_FINANCE =
  /пересл|скинь|отправ\w+|передай|перекинь/iu;

const idCache = new Map<string, string | null>();

export function isFinanceMatter(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (FINANCE_DOC.test(t)) return true;
  if (CHECKOUT_BUG.test(t) || ORDER_OR_CHECKOUT.test(t)) return false;
  return MONEY_MOVE.test(t);
}

export function messageLooksFinancial(
  current: string,
  quoted?: string,
): boolean {
  if (isFinanceMatter(current)) return true;
  const quote = (quoted || "").trim();
  if (!quote || !isFinanceMatter(quote)) return false;
  return FORWARD_FINANCE.test(current) && /клиент/iu.test(current);
}

function attachmentName(message: {
  document?: { file_name?: string };
  video?: { file_name?: string };
  animation?: { file_name?: string };
} | undefined): string {
  return (
    message?.document?.file_name ||
    message?.video?.file_name ||
    message?.animation?.file_name ||
    ""
  );
}

export function financeProbe(ctx: BotContext): { current: string; quoted: string } {
  const message = ctx.message;
  const reply = message?.reply_to_message;
  const current = [message?.text, message?.caption, attachmentName(message)]
    .filter(Boolean)
    .join("\n");
  const quoted = [reply?.text, reply?.caption, attachmentName(reply)].filter(Boolean).join("\n");
  return { current, quoted };
}

function financePeople(): TeamMember[] {
  const wanted = new Set<string>(FINANCE_CONTACT_KEYS);
  return loadTeamConfig().people.filter((person) => wanted.has(person.key));
}

async function recipientId(api: Api, person: TeamMember): Promise<string | null> {
  if (person.telegram_user_id) return person.telegram_user_id;
  if (idCache.has(person.key)) return idCache.get(person.key) ?? null;
  if (!person.telegram_username) {
    idCache.set(person.key, null);
    return null;
  }
  try {
    const chat = await api.getChat(`@${person.telegram_username}`);
    const id = String(chat.id);
    idCache.set(person.key, id);
    return id;
  } catch (error) {
    idCache.set(person.key, null);
    console.error(
      `finance: у ${person.display_name} нет telegram_user_id, личку не отправить`,
      error,
    );
    return null;
  }
}

function senderLabel(ctx: BotContext): string {
  const from = ctx.from;
  if (!from) return "неизвестно";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const at = from.username ? ` @${from.username}` : "";
  return `${name || "без имени"}${at}`.trim();
}

/**
 * Финансовый вопрос не обсуждается и не пересылается.
 * Текст и вложение уходят в личку Виктории, Павлу и Станиславу.
 * Возвращает true, если сообщение перехвачено.
 */
export async function holdFinanceMessage(ctx: BotContext): Promise<boolean> {
  const { current, quoted } = financeProbe(ctx);
  if (!messageLooksFinancial(current, quoted)) return false;

  const chatTitle = ctx.chat?.title || (ctx.chat?.type === "private" ? "личка" : "чат");
  const body = [
    "Финансовый вопрос. В чат не отвечала и ничего не пересылала — это только вам.",
    "",
    `Чат: ${chatTitle}`,
    `От: ${senderLabel(ctx)}`,
    "",
    current.trim() || quoted.trim() || "(без текста, смотрите вложение)",
  ].join("\n");

  const senderId = ctx.from?.id != null ? String(ctx.from.id) : null;
  const sourceChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
  const messageId = ctx.message?.message_id;
  let delivered = 0;

  for (const person of financePeople()) {
    const chatId = await recipientId(ctx.api, person);
    if (!chatId) continue;
    if (sourceChatId && chatId === sourceChatId) continue;
    if (ctx.chat?.type === "private" && senderId && chatId === senderId) continue;
    try {
      await ctx.api.sendMessage(Number(chatId), body.slice(0, 3500));
      if (messageId != null && ctx.chat?.id != null) {
        await ctx.api.copyMessage(Number(chatId), ctx.chat.id, messageId);
      }
      delivered += 1;
    } catch (error) {
      console.error(`finance: не удалось написать ${person.display_name}`, error);
    }
  }

  if (!delivered) {
    console.error("finance: вопрос перехвачен, но личные сообщения не доставлены");
  }
  return true;
}
