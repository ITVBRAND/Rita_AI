import { env } from "../env.js";
import { CLIENT_VOICE_SYSTEM, buildClientVoiceUserPayload } from "./vikaStyle.js";
import { openaiJson } from "../ai/openaiHttp.js";

export async function answerClientQuestion(params: {
  projectName: string;
  question: string;
  issueSummary: string;
  thread: string;
}): Promise<string> {
  const fallback = "Добрый день!\n\nПереспрошу у разработчиков и вернусь с ответом.";
  if (!env.openaiApiKey) return fallback;

  try {
    const data = await openaiJson<{
      choices?: Array<{ message?: { content?: string } }>;
    }>("chat/completions", {
        model: env.openaiModel,
        temperature: 0.35,
        messages: [
          { role: "system", content: CLIENT_VOICE_SYSTEM },
          {
            role: "user",
            content: buildClientVoiceUserPayload({
              kind: "answer_client_question",
              project: params.projectName,
              client_question: params.question,
              issue_summary: params.issueSummary,
              conversation_thread: params.thread.slice(0, 4000),
              instruction:
                "Ответь клиенту по контексту. Если причины нет в thread — «Переспрошу» / уточним у разработчиков. Стиль Вики, 2–4 предложения.",
            }),
          },
        ],
    });
    return data.choices?.[0]?.message?.content?.trim() || fallback;
  } catch {
    return fallback;
  }
}

export async function wrapDevMessageForClientWithContext(
  devText: string,
  projectName: string,
  issueSummary: string,
  thread: string,
): Promise<string> {
  const fallback =
    devText.length < 400
      ? devText
      : `Добрый день!\n\n${devText.slice(0, 900)}`;
  if (!env.openaiApiKey) return fallback;

  try {
    const data = await openaiJson<{
      choices?: Array<{ message?: { content?: string } }>;
    }>("chat/completions", {
        model: env.openaiModel,
        temperature: 0.3,
        messages: [
          { role: "system", content: CLIENT_VOICE_SYSTEM },
          {
            role: "user",
            content: buildClientVoiceUserPayload({
              kind: "pass_dev_update",
              project: projectName,
              issue_summary: issueSummary,
              conversation_thread: thread.slice(0, 3000),
              dev_raw_text: devText.slice(0, 1500),
              instruction:
                "Переформулируй ответ разработчиков для клиента. Если они ещё проверяют или обещают сообщить, когда исправят, не пиши, что уже готово и всё работает. Начни с «Добрый день!» при необходимости, без жаргона, как Вика.",
            }),
          },
        ],
    });
    return data.choices?.[0]?.message?.content?.trim() || fallback;
  } catch {
    return fallback;
  }
}
