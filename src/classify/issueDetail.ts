import type { Skill } from "../config/types.js";
import { extractOrderRef } from "./orderRef.js";

const GENERIC_ONLY_RE =
  /^(?:@?\w+\s+)?(?:привет!?|здравствуйте!?|добрый\s+(?:день|вечер|утро)!?)\s*[.!]?\s*/i;

const VAGUE_BUG_RE =
  /^(?:на\s+)?(?:сайте\s+)?(?:есть\s+)?(?:какая[-\s]?то\s+)?(?:ошибк|проблем|глюк|сбой|баг)/i;

const SPECIFIC_DETAIL_RE =
  /https?:\/\/|www\.|\/catalog|\/personal|страниц|экран|кнопк|модальн|корзин|оформлен|checkout|404|500|exception|не\s+открыва|не\s+груз|не\s+запуска|не\s+нажима|не\s+добавля|не\s+приходит|не\s+проходит|не\s+могу\s+(?:оформить|оплатить|войти|зайти)|личн(?:ый|ого)\s+кабинет|лк\b|смс|юкасс|bitrix|битрикс|админк|скрин|скриншот|вот\s+так|текст\s+ошибк|остат|не\s+обновля|склад|синхрон/i;

const SYMPTOM_RE = /не\s+работает|не\s+запуска|не\s+открыва|ошибк|сайт|баг|слома/i;
const UNKNOWN_CAUSE_RE = /не\s*знаю|незнаю|без\s+ошибк|просто\s+не|не\s+понима|какая\s+ошибк/i;
const FILLER_RE = /^(?:спасибо|благодарю|ок|окей|хорошо|ага|угу)[.!]?$/i;

export interface ClientReportAssessment {
  readyForDev: boolean;
  clarifyQuestion: string | null;
}

function normalizedBody(text: string): string {
  return text.replace(GENERIC_ONLY_RE, "").replace(/\s+/g, " ").trim();
}

export function assessClientReport(params: {
  text: string;
  hasMedia: boolean;
  orderRef: string | null;
  skill: Skill;
}): ClientReportAssessment {
  const body = normalizedBody(params.text);
  const orderRef = params.orderRef ?? extractOrderRef(params.text);
  const clientLines = params.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !FILLER_RE.test(l) && !/^заказ\s*№/i.test(l));

  if (params.hasMedia) {
    if (body.length < 15 && !orderRef && params.skill === "payment") {
      return {
        readyForDev: false,
        clarifyQuestion: buildClientClarifyQuestion(params.skill, params.text, orderRef),
      };
    }
    return { readyForDev: true, clarifyQuestion: null };
  }

  if (params.skill === "payment" || params.skill === "onec") {
    if (
      params.skill === "onec" &&
      /остат|не\s+подтяг|синхрон|выгруз/i.test(params.text) &&
      !/номер\s+заказ|оплат|юкасс/i.test(params.text)
    ) {
      return { readyForDev: true, clarifyQuestion: null };
    }
    if (!orderRef && /заказ|оплат|доставк|сделк|юкасс|crm|битрикс|1\s*с/i.test(params.text)) {
      return {
        readyForDev: false,
        clarifyQuestion:
          "Добрый день!\n\nПриняли обращение. Подскажите, пожалуйста, номер заказа или сделки — и что именно пошло не так (оплата, сумма, статус в CRM).",
      };
    }
    if (orderRef && body.length >= 20) {
      return { readyForDev: true, clarifyQuestion: null };
    }
    if (orderRef && body.length < 20) {
      return {
        readyForDev: false,
        clarifyQuestion:
          "Добрый день!\n\nСпасибо за номер. Что именно не так с заказом — оплата, доставка, статус, сумма? Если есть — текст ошибки или скрин.",
      };
    }
  }

  const hasSpecific =
    body.length >= 90 ||
    SPECIFIC_DETAIL_RE.test(body) ||
    (orderRef != null && body.length >= 25);

  if (hasSpecific) {
    return { readyForDev: true, clarifyQuestion: null };
  }

  const clientSaidEnough =
    SYMPTOM_RE.test(body) &&
    (UNKNOWN_CAUSE_RE.test(body) || clientLines.length >= 2);
  if (clientSaidEnough && params.skill !== "payment" && params.skill !== "onec") {
    return { readyForDev: true, clarifyQuestion: null };
  }

  const looksVague =
    body.length < 55 ||
    VAGUE_BUG_RE.test(body) ||
    /^(?:ошибк|проблем|не\s+работает|сломал)/i.test(body);

  if (looksVague) {
    return {
      readyForDev: false,
      clarifyQuestion: buildClientClarifyQuestion(params.skill, params.text, orderRef),
    };
  }

  return { readyForDev: true, clarifyQuestion: null };
}

export function buildClientClarifyQuestion(
  skill: Skill,
  originalText: string,
  orderRef: string | null,
): string {
  const lines = [
    "Добрый день!",
    "",
    "Приняли обращение. Чтобы передать разработчикам с полной картиной, подскажите, пожалуйста:",
  ];

  if (skill === "payment" || /заказ|оплат/i.test(originalText)) {
    if (!orderRef) {
      lines.push("— номер заказа или сделки;");
    }
  }

  if (/не\s+работает|не\s+запуска|сайт/i.test(originalText) && skill !== "payment") {
    return "Добрый день!\n\nПодскажите, сайт совсем не открывается или на экране есть текст ошибки? Если ошибка видна — напишите её или пришлите скрин.";
  }

  lines.push("— что именно не так и, если видно, текст ошибки или скрин.");
  lines.push("", "Спасибо!");

  return lines.join("\n");
}
