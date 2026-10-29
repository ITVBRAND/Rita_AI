import { env } from "../env.js";
import { STAFF_ASSISTANT_SYSTEM } from "./prompts.js";
import { formatTeamRosterForPrompt, type TeamMember } from "../team/loadTeam.js";
import { isIdleChatter } from "../bot/clientChatGuards.js";
import type { StaffThreadLine } from "./session.js";

function isPlayfulStaffMessage(text: string): boolean {
  return (
    isIdleChatter(text) ||
    /прикол|шутк|ахах|хах|lol|😁|🤣|:\)|;\)|rofl/i.test(text)
  );
}

export interface StaffAssistantContext {
  member: TeamMember;
  text: string;
  chatType: "private" | "group" | "supergroup" | string;
  chatTitle?: string;
  projectName?: string;
  projectSlug?: string;
  chatRole?: "client" | "executor" | "staff";
  conversationHistory?: StaffThreadLine[];
  /** Реплики старше короткого окна. Есть только если вопрос к ним относится. */
  earlierDialogue?: StaffThreadLine[];
  dialogueSummary?: string;
  lessons?: string;
  problemStatus?: string;
  /** Уже сделанное действие, о котором нужно сказать прямо. */
  handoffNote?: string;
}

function fallbackReply(ctx: StaffAssistantContext): string {
  const t = ctx.text.toLowerCase();
  if (/групп|не ответ|тишин|не видит|не отвечаешь/.test(t)) {
    return [
      "В группе я отвечаю, если вижу сообщение: «Рита», @vbrand_pm_bot или reply на меня.",
      "Если тишина — в @BotFather выключите Group Privacy для бота, проверьте /bind newarmor client в этой группе и что бот в чате.",
      "При включённой Privacy без @бота Telegram мне сообщение не присылает — это ограничение API, не «молчу специально».",
    ].join("\n");
  }
  if (isPlayfulStaffMessage(ctx.text)) {
    return "Ахах, вижу вас) Если по работе — спрашивайте, я тут.";
  }
  if (
    /(?:тво[яюей]\s+фамили|фамили[яю]\s*(?:у\s+тебя|тво[яю])|какая\s+(?:у\s+тебя\s+)?фамили|как\s+(?:твоя\s+)?фамили|кто\s+(?:твой|тебя)\s+(?:отец|папа)|твой\s+(?:отец|папа)|кто\s+тебя\s+родил)/iu.test(
      ctx.text,
    )
  ) {
    return "Ткачева) Отец — Станислав Ткачев.";
  }
  if (/клиент|написать|формулир|текст/.test(t)) {
    return "Могу подсказать формулировку. Опишите суть проблемы клиента своими словами — предложу короткий текст для client-чата.";
  }
  if (/куда|передать|dev|разработ/.test(t)) {
    return "Обращение клиента — client-чат (уточню и перешлю в dev). Ответ клиенту — reply на сообщение Rita в dev-чате.";
  }
  if (/bind|привяз/.test(t)) {
    return "В группе от админа: /bind newarmor client или /bind newarmor executor. Список: /projects.";
  }
  return `${ctx.member.display_name}, слушаю. Напишите, что случилось — разберёмся.`;
}

export async function generateStaffAssistantReply(
  ctx: StaffAssistantContext,
): Promise<string> {
  const fallback = fallbackReply(ctx);
  if (!env.openaiApiKey) return fallback;

  try {
    const history = ctx.conversationHistory ?? [];
    const continuing = history.length > 0;
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: STAFF_ASSISTANT_SYSTEM },
    ];
    for (const line of history) {
      messages.push({
        role: line.who === "rita" ? "assistant" : "user",
        content: line.text,
      });
    }
    const earlier = ctx.earlierDialogue ?? [];
    const earlierBlock = earlier.length
      ? [
          "Фрагменты более ранней переписки (опирайся на них, если вопрос про прошлое или про эту тему; не пересказывай, если вопрос не про них; не выдумывай реплик, которых здесь нет):",
          ...earlier.map((line) => `${line.who === "rita" ? "Рита" : "Коллега"}: ${line.text}`),
        ].join("\n")
      : "";
    const facts = [
      `Коллега: ${ctx.member.display_name}, ${ctx.member.role_label}.`,
      `Чат: ${ctx.chatTitle || ctx.chatType}. Проект: ${ctx.projectName || "—"}. binding: ${ctx.chatRole || "—"}.`,
      ctx.chatRole === "staff" && !ctx.handoffNote
        ? "Это внутренний чат сотрудников V-Brand, не рабочий и не клиентский. Поддержи диалог. Не предлагай тикет, пересылку клиенту и /bind."
        : "",
      continuing
        ? "Диалог уже идёт: реплики выше — это сохранённая переписка. Не здоровайся и не повторяй предыдущий ответ. Ответь на реплику ниже, с учётом этой истории."
        : "Это начало диалога.",
      earlierBlock,
      ctx.dialogueSummary ? `Память этого диалога:\n${ctx.dialogueSummary}` : "",
      ctx.problemStatus ? `Статусы обращений:\n${ctx.problemStatus}` : "",
      ctx.lessons ? `Правила, которые уже выяснили. Соблюдай их:\n${ctx.lessons}` : "",
      ctx.handoffNote || "",
      `Команда: ${formatTeamRosterForPrompt()}`,
    ]
      .filter(Boolean)
      .join("\n");
    messages.push({
      role: "user",
      content: `${facts}\n\n${ctx.text.slice(0, 2000)}`,
    });

    const res = await fetch(`${env.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.openaiModel,
        temperature: isPlayfulStaffMessage(ctx.text) ? 0.55 : 0.35,
        messages,
      }),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text || text.length > 1200) return fallback;
    if (/```|<\/?code>|function\s*\(|import\s+/.test(text)) return fallback;
    return text;
  } catch {
    return fallback;
  }
}
