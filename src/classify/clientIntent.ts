import { env } from "../env.js";
import { isContentCatalogTask } from "./contentTask.js";

export type ClientIntentKind = "content" | "incident" | "advice";

export interface ClientIntent {
  kind: ClientIntentKind;
  /** Ответ клиенту без приветствия. О себе — женский род. */
  reply: string;
}

const ADVICE_RE =
  /плюс|минус|что\s+(?:вы\s+)?дума|свой\s+взгляд|проработ|стоит\s+ли|подключ|функци|посовет|как\s+лучше|имеет\s+смысл|оцените|мнение/i;

const INCIDENT_RE = /ошибк|не\s+работает|не\s+открыва|баг|не\s+заходит|упал|не\s+запуска|слом/i;

const CANNED_RE = /это\s+неприятно|уже\s+передали\s+разработчик/i;

const SYSTEM = `Ты Рита, менеджер поддержки интернет-магазина. Разбери реплику и верни ТОЛЬКО JSON: {"kind":"content"|"incident"|"advice","reply":"..."}.

kind=content — завести или заполнить товар, фото, описание, цену карточки.
kind=incident — что-то сломано: сайт, оплата, корзина, личный кабинет, 1С, остатки, «не работает».
kind=advice — просят взгляд, плюсы и минусы, проработать подключение функции, оценить идею. Это не поломка, даже если речь про сайт или оплату.

reply — текст клиенту, без «Добрый день» и без имени. О себе только женский род: поняла, приняла, посмотрела, передала.
content: что приняла и что передала на заполнение карточки. Не пиши «неприятно».
incident: коротко по сути поломки и что передала разработчикам. Не обещай, что уже починили.
advice: короткий предварительный взгляд, 4–7 предложений. Если в тексте есть ссылка, пойми сервис: sbp.nspk.ru — это СБП, не «функция вообще». Назови 2 плюса и 2 минуса для интернет-магазина. Не выдумывай цены, сроки и что интеграция уже сделана. Рита не принимает решение о внедрении. В конце прямо: сама это не решаешь и передала вопрос разработчикам на согласование. Не пиши «обсужу с командой» и не называй это аварией.`;

function adviceFallback(text: string): string {
  if (/sbp\.nspk|сбп|систем[аы]\s+быстрых\s+платеж/i.test(text)) {
    return [
      "Посмотрела ссылку: это СБП для бизнеса, оплата из банковского приложения.",
      "Плюсы для магазина: покупателю не нужна карта, зачисление быстрое, комиссия часто ниже обычного эквайринга.",
      "Минусы: подключение идёт через банк или платёжного партнёра, возвраты и чеки нужно стыковать с текущей оплатой, в корзине появится ещё один сценарий.",
      "Сама внедрение не решаю — передала вопрос разработчикам на согласование.",
    ].join(" ");
  }
  return "Приняла. Это доработка, не ошибка. Сама внедрение не решаю — передала вопрос разработчикам на согласование.";
}

function fallback(text: string): ClientIntent {
  if (isContentCatalogTask(text) && !INCIDENT_RE.test(text)) {
    return { kind: "content", reply: "Приняла. Передала на заполнение карточки товара." };
  }
  if (INCIDENT_RE.test(text) && !ADVICE_RE.test(text)) {
    return {
      kind: "incident",
      reply: "Поняла, это неприятно. Разбираемся и уже передали разработчикам.",
    };
  }
  if (ADVICE_RE.test(text)) return { kind: "advice", reply: adviceFallback(text) };
  return { kind: "advice", reply: "Приняла. Обсужу с коллегами и вернусь." };
}

function cleanReply(kind: ClientIntentKind, reply: string, text: string): string {
  let out = reply.replace(/\s+/g, " ").trim();
  out = out.replace(/^(?:добрый день|здравствуйте)[,!]?\s*/i, "").trim();
  const limit = kind === "advice" ? 1200 : 320;
  if (!out || out.length > limit) return fallback(text).reply;
  if (kind !== "incident" && CANNED_RE.test(out)) {
    return kind === "content"
      ? "Приняла. Передала на заполнение карточки товара."
      : adviceFallback(text);
  }
  if (kind === "advice" && !/разработчик/i.test(out)) {
    out = `${out} Сама внедрение не решаю — передала вопрос разработчикам на согласование.`;
  }
  return out;
}

function parseKind(raw: string | undefined, text: string): ClientIntentKind {
  if (raw === "content" || raw === "incident" || raw === "advice") {
    if (raw === "incident" && ADVICE_RE.test(text) && !INCIDENT_RE.test(text)) return "advice";
    return raw;
  }
  return fallback(text).kind;
}

export function greetClient(reply: string, persona?: string | null): string {
  const who = persona ? `, ${persona}` : "";
  const body = reply.replace(/^(?:добрый день|здравствуйте)[,!]?\s*/i, "").trim();
  return `Добрый день${who}!\n${body}`;
}

export async function understandClientRequest(text: string): Promise<ClientIntent> {
  const safe = fallback(text);
  if (!env.openaiApiKey || !text.trim()) return safe;

  try {
    const res = await fetch(`${env.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.openaiModel,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text.slice(0, 2000) },
        ],
      }),
    });
    if (!res.ok) {
      console.error("client intent LLM error", res.status, await res.text());
      return safe;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}") as {
      kind?: string;
      reply?: string;
    };
    const kind = parseKind(parsed.kind, text);
    return { kind, reply: cleanReply(kind, String(parsed.reply || ""), text) };
  } catch (err) {
    console.error("client intent failed", err);
    return safe;
  }
}
