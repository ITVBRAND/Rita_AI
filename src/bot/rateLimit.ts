import type { BotContext } from "./context.js";

const MAX_MESSAGES_PER_MINUTE = 30;
const NOTICE_COOLDOWN_MS = 30_000;
const eventsByUser = new Map<string, number[]>();
const lastNoticeByUser = new Map<string, number>();

export async function botMessageRateLimit(ctx: BotContext, next: () => Promise<void>): Promise<void> {
  if (!ctx.message || !ctx.from || ctx.from.is_bot) return next();
  const key = String(ctx.from.id);
  const now = Date.now();
  const recent = (eventsByUser.get(key) ?? []).filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= MAX_MESSAGES_PER_MINUTE) {
    eventsByUser.set(key, recent);
    const lastNotice = lastNoticeByUser.get(key) ?? 0;
    if (now - lastNotice >= NOTICE_COOLDOWN_MS) {
      lastNoticeByUser.set(key, now);
      await ctx.reply("Слишком много сообщений за минуту. Подожди немного и отправь запрос ещё раз.");
    }
    return;
  }
  recent.push(now);
  eventsByUser.set(key, recent);
  await next();
}
