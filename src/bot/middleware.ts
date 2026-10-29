import type { NextFunction } from "grammy";
import { getProjectByChatId } from "../config/loadProjects.js";
import type { BotContext } from "./context.js";

export async function projectMiddleware(ctx: BotContext, next: NextFunction) {
  const chatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
  if (chatId) {
    ctx.projectInfo = await getProjectByChatId(chatId);
  } else {
    ctx.projectInfo = null;
  }
  await next();
}
