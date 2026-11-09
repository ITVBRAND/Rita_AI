import type { BotContext } from "./context.js";

const TELEGRAM_TEXT_LIMIT = 3_900;

function splitMessage(text: string, limit: number): string[] {
  const remaining = text.trim();
  if (!remaining) return [];
  if (remaining.length <= limit) return [remaining];

  const parts: string[] = [];
  let rest = remaining;
  while (rest.length > limit) {
    let cut = Math.max(
      rest.lastIndexOf("\n\n", limit),
      rest.lastIndexOf("\n", limit),
      rest.lastIndexOf(" ", limit),
    );
    if (cut < Math.floor(limit * 0.6)) cut = limit;
    // Keep UTF-16 surrogate pairs intact when a long unbroken token hits the boundary.
    if (cut > 0 && cut < rest.length && /[\uD800-\uDBFF]/.test(rest[cut - 1]!) && /[\uDC00-\uDFFF]/.test(rest[cut]!)) cut--;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function replyInTelegramParts(ctx: BotContext, text: string): Promise<void> {
  for (const part of splitMessage(text, TELEGRAM_TEXT_LIMIT)) {
    await ctx.reply(part);
  }
}

export async function withTyping<T>(ctx: BotContext, work: () => Promise<T>): Promise<T> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return work();

  const sendTyping = () => {
    void ctx.api.sendChatAction(chatId, "typing").catch((error) => {
      console.warn("Telegram typing indicator failed", error);
    });
  };
  sendTyping();
  const timer = setInterval(sendTyping, 4_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
