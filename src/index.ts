import { Bot } from "grammy";
import { assertBotToken, env } from "./env.js";
import { syncProjectsFromYaml } from "./config/loadProjects.js";
import { getClassifyMode } from "./classify/index.js";
import { privateChatAccessMiddleware, projectMiddleware } from "./bot/middleware.js";
import { botMessageRateLimit } from "./bot/rateLimit.js";
import { registerHandlers } from "./bot/handlers.js";
import { startProblemEscalationLoop } from "./relay/problemEscalation.js";
import type { BotContext } from "./bot/context.js";
import { backfillSharedMemoryEmbeddings } from "./memory/ritaMemory.js";
import { reflectPendingExperiences } from "./memory/experienceLearning.js";

async function main() {
  const token = assertBotToken();
  await syncProjectsFromYaml();

  const bot = new Bot<BotContext>(token);
  bot.use(botMessageRateLimit);
  bot.use(privateChatAccessMiddleware);
  bot.use(projectMiddleware);
  registerHandlers(bot);
  startProblemEscalationLoop(bot);

  bot.catch((err) => {
    console.error("Bot error", err.error);
  });

  console.log(`classify mode: ${getClassifyMode()}`);
  console.log(`admins: ${[...env.adminUserIds].join(",") || "(none)"}`);
  console.log(`weeek: ${env.weeekApiToken ? "enabled" : "disabled"}`);
  void backfillSharedMemoryEmbeddings().catch((error) => console.error("shared memory vector backfill failed", error));
  void reflectPendingExperiences().catch((error) => console.error("experience reflection worker failed", error));
  setInterval(() => {
    void reflectPendingExperiences().catch((error) => console.error("experience reflection worker failed", error));
  }, 60_000);
  await bot.start({
    onStart: (info) => console.log(`PM bot @${info.username} started`),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
