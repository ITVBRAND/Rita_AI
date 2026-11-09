import { env } from "../env.js";
import { openaiJson } from "../ai/openaiHttp.js";
import { CLIENT_VOICE_SYSTEM, buildClientVoiceUserPayload } from "./vikaStyle.js";
import {
  sanitizeReplyAgainstClientFacts,
  stripLeadingGreeting,
} from "../classify/issueSummary.js";

export type ClientReplyKind = "ack" | "clarify" | "resolved";

export interface ClientReplyContext {
  kind: ClientReplyKind;
  projectName: string;
  clientText: string;
  summary: string;
  clarifyHint: string | null;
  orderRef: string | null;
  hasMedia: boolean;
  openTickets: Array<{ summary: string; status: string }>;
  /** Уже был диалог по этому обращению — без повторного «Добрый день!» */
  isFollowUp?: boolean;
  /** Имя, которым представляется собеседник в роли клиента */
  clientName?: string | null;
  /** Все реплики клиента по теме (для проверки фактов) */
  clientCorpus?: string;
}

function finalizeClientText(text: string, ctx: ClientReplyContext): string {
  let out = text;
  const corpus = ctx.clientCorpus || `${ctx.clientText}\n${ctx.summary}`;
  out = sanitizeReplyAgainstClientFacts(out, corpus);
  if (ctx.isFollowUp && ctx.kind !== "clarify") {
    out = stripLeadingGreeting(out);
  }
  if (ctx.isFollowUp && ctx.kind === "ack" && !out.trim()) {
    out = /ошибк|не\s+работает|баг|не\s+открыва/i.test(corpus)
      ? "Поняла, это неприятно. Разбираемся и уже передали разработчикам."
      : "Приняла. Обсужу с коллегами и вернусь.";
  }
  return out.trim();
}

function scriptReply(ctx: ClientReplyContext): string {
  if (ctx.kind === "clarify") {
    if (ctx.clarifyHint) return ctx.clarifyHint;
    if (ctx.hasMedia && !ctx.orderRef) {
      return "Добрый день!\n\nСпасибо за скрин. Подскажите, пожалуйста, номер заказа или сделки — так быстрее разберёмся.";
    }
    return "Добрый день!\n\nПереспрошу";
  }

  if (ctx.kind === "resolved") {
    return finalizeClientText(
      ctx.isFollowUp ? "Готово" : "Добрый день!\n\nГотово",
      ctx,
    );
  }

  if (ctx.openTickets.length > 0) {
    return finalizeClientText("Разбираемся, спасибо за дополнение", ctx);
  }

  if (ctx.hasMedia && !ctx.clientText.trim()) {
    return finalizeClientText(
      ctx.isFollowUp
        ? "Увидели вложение, передали разработчикам."
        : "Добрый день!\nРазбираемся\n\nЕсли можно — одной фразой опишите, что на скрине",
      ctx,
    );
  }

  const incident = /ошибк|не\s+работает|баг|не\s+открыва/i.test(`${ctx.clientText}\n${ctx.summary}`);
  return finalizeClientText(
    incident
      ? ctx.isFollowUp
        ? "Поняла, это неприятно. Разбираемся и уже передали разработчикам."
        : "Добрый день!\nПоняла, это неприятно. Разбираемся."
      : "Приняла. Обсужу с коллегами и вернусь.",
    ctx,
  );
}

export async function generateClientReply(ctx: ClientReplyContext): Promise<string> {
  const corpus = `${ctx.clientText}\n${ctx.summary}\n${ctx.clientCorpus || ""}`;
  if (
    ctx.kind === "ack" &&
    /не\s*знаю|незнаю|не\s+работает|не\s+запуска|ошибк/i.test(corpus)
  ) {
    const name = ctx.clientName ? `, ${ctx.clientName}` : "";
    return ctx.isFollowUp
      ? "Поняла, это неприятно. Разбираемся и уже передали разработчикам."
      : `Добрый день${name}!\nПоняла, это мешает. Разбираемся и уже передали разработчикам.`;
  }

  const fallback = scriptReply(ctx);
  if (
    ctx.kind === "clarify" &&
    ctx.clarifyHint &&
    ctx.clarifyHint.length > 50 &&
    !ctx.isFollowUp
  ) {
    return ctx.clarifyHint;
  }
  if (!env.openaiApiKey) return fallback;

  const payload = {
    kind: ctx.kind,
    project: ctx.projectName,
    client_message: ctx.clientText,
    problem_summary: ctx.summary,
    order_ref: ctx.orderRef,
    has_media: ctx.hasMedia,
    clarify_hint: ctx.clarifyHint,
    open_issues: ctx.openTickets.slice(0, 5).map((t) => ({
      status: t.status,
      summary: t.summary.slice(0, 200),
    })),
    is_follow_up: ctx.isFollowUp ?? false,
    client_name: ctx.clientName || null,
    client_corpus: ctx.clientCorpus?.slice(0, 1500),
    instruction:
      ctx.kind === "clarify"
        ? "Это сообщение уйдёт клиенту напрямую, от лица Вики. Не пиши черновик и не обращайся к сотруднику. Если есть client_name — обратись по этому имени. Один ответ: приветствие + 2–3 уточняющих вопроса по новой реплике. Если is_follow_up, не повторяй уже заданный вопрос и ответь на то, что клиент только что добавил. Не обещай сроков."
        : ctx.kind === "ack"
          ? "Коротко и по-человечески, только факты из client_corpus. Если клиент просит заполнить товар, прислать фото или описание для карточки — это не поломка: подтверди, что приняла и передала на заполнение. Не пиши «неприятно» и не упоминай разработчиков. Если это ошибка сайта, оплаты или 1С — посочувствуй и скажи, что передала разработчикам. Не задавай вопросов. Без канцелярита."
          : ctx.kind === "resolved"
            ? "Клиенту: проблема уже исправлена. Коротко перескажи, в чём была причина и что можно проверять, только если это написано в client_message. Не пиши, что ещё разбираетесь, и не обращайся к сотруднику."
            : undefined,
  };

  try {
    const data = await openaiJson<{
      choices?: Array<{ message?: { content?: string } }>;
    }>("chat/completions", {
        model: env.openaiModel,
        temperature: 0.4,
        messages: [
          { role: "system", content: CLIENT_VOICE_SYSTEM },
          {
            role: "user",
            content: buildClientVoiceUserPayload(payload),
          },
        ],
    });
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text || text.length > 600) return fallback;
    return finalizeClientText(text, ctx);
  } catch (e) {
    console.error("client voice failed", e);
    return fallback;
  }
}

/** @deprecated используйте wrapDevMessageForClientWithContext */
export async function wrapDevMessageForClient(devText: string, projectName: string): Promise<string> {
  const { wrapDevMessageForClientWithContext } = await import("./contextAnswer.js");
  return wrapDevMessageForClientWithContext(devText, projectName, "", "");
}
