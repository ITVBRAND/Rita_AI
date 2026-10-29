import { textAddressesRita } from "./ritaAddress.js";
import { isAdmin, isBotOwner } from "../env.js";
import type { ProjectRuntime } from "../config/types.js";
import { isVbrandTeamMember } from "../team/loadTeam.js";

const INSTRUCT_OTHER_RE =
  /(?:скажи|напиши|ответь|спроси|передай|притворись|сделай\s+вид|у\s+тебя\s+какие[-\s]?то)/i;

const IDLE_CHATTER_RE =
  /^(?:бля(?:ть)?|блин|lol|ахаха?|хаха?|\)+|\(+|\+|ок|окей|спасибо|хорош|всё|все|good|nice|алло|robot|робот|[\p{Emoji}\s!.…]+)$/iu;

const REAL_SUPPORT_RE =
  /не\s+работает|не\s+робит|ошибк|баг|сломал|сайт\s+нет|нет\s+сайта|не\s+открыва|не\s+груз|не\s+запуск|остат|заказ|оплат|не\s+могу|помогите|срочно|шо\s+делать/i;

export function isRegisteredProjectClient(
  from: { id?: number; username?: string },
  runtime: ProjectRuntime,
): boolean {
  const username = from.username?.toLowerCase();
  if (username && runtime.clientUsernames.has(username)) return true;
  if (from.id != null && runtime.clientTelegramIds.has(String(from.id))) return true;
  return false;
}

/** Просьба к другому человеку в чате («@dan скажи что…»), не обращение в поддержку. */
export function isInstructionToOtherPerson(
  text: string,
  mentionTexts: string[],
): boolean {
  const t = text.trim();
  if (!t) return false;
  if (textAddressesRita(t)) return false;
  if (mentionTexts.length === 0) return false;
  const hasMention = mentionTexts.some((m) => {
    const key = m.replace(/^@/, "").toLowerCase();
    return new RegExp(`@${key}\\b`, "i").test(t) || t.toLowerCase().includes(key);
  });
  if (!hasMention) return false;
  return INSTRUCT_OTHER_RE.test(t);
}

export function isIdleChatter(text: string): boolean {
  const c = text.replace(/\s+/g, " ").trim();
  if (!c || c.length > 40) return false;
  return IDLE_CHATTER_RE.test(c);
}

/** Админ-команда тестирует поддержку — похоже на реальное обращение, не шутка. */
export function looksLikeClientSupportRequest(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 8) return false;
  return REAL_SUPPORT_RE.test(t);
}

export function shouldIgnoreInClientChat(params: {
  text: string;
  mentionTexts: string[];
  from?: { id?: number; username?: string };
  runtime: ProjectRuntime;
}): boolean {
  const { text, mentionTexts, from, runtime } = params;
  if (!from) return true;
  if (isIdleChatter(text)) return true;
  if (isInstructionToOtherPerson(text, mentionTexts)) return true;

  if (isVbrandTeamMember(from)) {
    if (isRegisteredProjectClient(from, runtime)) return false;
    if (isBotOwner(from.id)) {
      return false;
    }
    if (runtime.allowAdminAsClient && isAdmin(from.id) && looksLikeClientSupportRequest(text)) {
      return false;
    }
    return true;
  }

  return false;
}
