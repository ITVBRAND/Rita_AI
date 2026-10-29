import { Bot } from "grammy";
import { assertBotToken, env } from "./env.js";
import { syncProjectsFromYaml } from "./config/loadProjects.js";
import { getClassifyMode } from "./classify/index.js";
import { projectMiddleware } from "./bot/middleware.js";
import { registerHandlers } from "./bot/handlers.js";
import type { BotContext } from "./bot/context.js";

async function main() {
  const token = assertBotToken();
  await syncProjectsFromYaml();

  const bot = new Bot<BotContext>(token);
  bot.use(projectMiddleware);
  registerHandlers(bot);

  bot.catch((err) => {
    console.error("Bot error", err.error);
  });

  console.log(`classify mode: ${getClassifyMode()}`);
  console.log(`admins: ${[...env.adminUserIds].join(",") || "(none)"}`);
  console.log(`weeek: ${env.weeekApiToken ? "enabled" : "disabled"}`);
  await bot.start({
    onStart: (info) => console.log(`PM bot @${info.username} started`),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
