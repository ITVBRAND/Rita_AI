import { isAdmin, isBotOwner } from "../env.js";
import type { ProjectRuntime } from "../config/types.js";
import type { BotContext } from "./context.js";
import {
  isRegisteredProjectClient,
  looksLikeClientSupportRequest,
  shouldIgnoreInClientChat,
} from "./clientChatGuards.js";
import { extractClientSimulationText, noteClientRole } from "./clientRolePlay.js";
import { textAddressesRita } from "./ritaAddress.js";
import { shouldTryStaffWeeek } from "../staffAssistant/weeekFromStaff.js";

export function formatClientLabel(ctx: BotContext): string {
  const u = ctx.from?.username ? `@${ctx.from.username}` : null;
  const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ");
  if (name && u) return `${name} (${u})`;
  return name || u || "Клиент";
}

export function extractMentionTextsForGuard(ctx: BotContext): string[] {
  const msg = ctx.message;
  if (!msg) return [];
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const raw = msg.text || msg.caption || "";
  const texts: string[] = [];
  for (const e of entities) {
    if (e.type === "mention") {
      texts.push(raw.slice(e.offset, e.offset + e.length).replace(/^@/, ""));
    } else if (e.type === "text_mention" && e.user?.username) {
      texts.push(e.user.username);
    }
  }
  return texts;
}

/** Сообщение считаем «от клиента», если автор — клиент проекта (не шутка/не сотрудник). */
export function isClientSpeaker(ctx: BotContext, runtime: ProjectRuntime): boolean {
  const from = ctx.from;
  if (!from) return false;

  const text = ctx.message?.text || ctx.message?.caption || "";
  const mentionTexts = extractMentionTextsForGuard(ctx);

  if (shouldIgnoreInClientChat({ text, mentionTexts, from, runtime })) {
    return false;
  }

  if (isRegisteredProjectClient(from, runtime)) return true;

  if (isBotOwner(from.id) || noteClientRole(ctx, text)) {
    if (noteClientRole(ctx, text)) return true;
    if (textAddressesRita(text) || shouldTryStaffWeeek(text)) return false;
    if (extractClientSimulationText(text)) return true;
    if (looksLikeClientSupportRequest(text)) return true;
    if (ctx.message?.reply_to_message?.from?.is_bot) return true;
    return false;
  }

  if (runtime.allowAdminAsClient && isAdmin(from.id)) return true;

  if (
    runtime.clientUsernames.size === 0 &&
    runtime.clientTelegramIds.size === 0
  ) {
    return true;
  }

  return false;
}
