import type { NextFunction } from "grammy";
import { getProjectByChatId } from "../config/loadProjects.js";
import { isAdmin, isBotOwner } from "../env.js";
import { prisma } from "../db/client.js";
import { isVbrandTeamMember } from "../team/loadTeam.js";
import type { BotContext } from "./context.js";

export async function privateChatAccessMiddleware(ctx: BotContext, next: NextFunction) {
  if (ctx.chat?.type !== "private") return next();

  const userId = ctx.from?.id;
  if (!userId) return next();
  if (isBotOwner(userId) || isAdmin(userId)) {
    ctx.privateChatAuthorized = true;
    return next();
  }

  const access = await prisma.privateChatAccess.findUnique({
    where: { userId: String(userId) },
    select: { allowed: true },
  });
  if (access) {
    if (access.allowed) {
      ctx.privateChatAuthorized = true;
      return next();
    }
    await ctx.reply("Доступ к личным сообщениям Риты для этого аккаунта отключён.");
    return;
  }

  if (isVbrandTeamMember(ctx.from)) {
    ctx.privateChatAuthorized = true;
    return next();
  }

  await ctx.reply("Личные сообщения Рите доступны только пользователям из списка доступа. Попросите администратора добавить ваш Telegram ID.");
}

export async function projectMiddleware(ctx: BotContext, next: NextFunction) {
  const chatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
  if (chatId) {
    ctx.projectInfo = await getProjectByChatId(chatId);
  } else {
    ctx.projectInfo = null;
  }
  await next();
}
