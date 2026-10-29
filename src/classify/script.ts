import type { Skill } from "../config/types.js";
import type { ClassifyInput, ClassifyResult } from "./types.js";
import { isClientEvidenceMessage, isContentCatalogTask } from "./contentTask.js";
import { extractOrderRef, ORDER_RE } from "./orderRef.js";
import { assessClientReport } from "./issueDetail.js";

const IGNORE_EXACT_RE =
  /^(спасибо|благодарю|ок|окей|хорошо|добрый день!?|доброе утро!?|добрый вечер!?|привет!?|пока!?|ага|угу|\+|👍|👌🏻?)$/i;
const RESOLVED_RE =
  /\b(готово|решено|закры(л|то|ваем)|исправлено|исправил(и)?|починил(и)?|fixed|всё\s+исправ)\b/i;
const WAIT_CLIENT_RE = /\b(нужен ответ клиента|уточните у клиента|спросите клиента)\b/i;
const SECRET_RE = /\b(password|пароль|login|логин)\s*[:=]/i;

const BUG_RE =
  /не\s+работает|ошибк|баг|слома|не\s+прилета|зависа|проблем|расхожд|неверн|не\s+коррект|некоррект|упал|недоступ|не\s+подтягива|не\s+открыва|не\s+заходит|не\s+приходит\s+смс|юкасс|yookassa|эквайринг|модальн|вылетел|админк/i;

const TECH_SUPPORT_RE =
  /админк|модальн|вылетел|компонент|php|обновлен|панел|бэкенд|backend|что\s+делать|помогите|подскажите|не\s+получается|не\s+могу/i;


const TASK_RE =
  /\b(нужно|надо|просьба|задача|сделай(те)?|добавь(те)?|заполни(те)?|поставь(те)?|проверьте|посмотри(те)?)\b/i;

const NEEDS_ORDER_RE =
  /юкасс|yookassa|оплат|доставк|битрикс|b24|crm|лк|смс|заказ.*(не|ошиб)|сделк/i;

function detectSkill(text: string): Skill {
  const t = text.toLowerCase();
  if (/юкасс|yookassa|оплат|эквайринг|доставк/.test(t) && !isContentCatalogTask(text)) {
    return "payment";
  }
  if (/остат|склад|синхрон|выгруз|не\s+обновля/.test(t)) return "onec";
  if (/1\s*[сc]\b|эдо|\bofd\b|офд|склад/.test(t)) return "onec";
  if (
    /битрикс|b24|crm|лк|личн(ый|ого)\s*кабинет|смс|аспро|админк|php|модальн|сайт/.test(t) ||
    (isContentCatalogTask(text) && /сайт|каталог|товар|карточк/.test(t))
  ) {
    return "site";
  }
  return "general";
}

function isWorkMessage(
  text: string,
  hasMedia: boolean,
  openTicketCount: number,
): boolean {
  if (hasMedia && isClientEvidenceMessage(text, true)) return true;
  if (hasMedia && isContentCatalogTask(text)) return true;
  if (BUG_RE.test(text)) return true;
  if (TECH_SUPPORT_RE.test(text) && text.trim().length >= 6) return true;
  if (isContentCatalogTask(text)) return true;
  if (TASK_RE.test(text) && detectSkill(text) !== "general") return true;
  if (ORDER_RE.test(text) && (BUG_RE.test(text) || /заказ|сделк|оплат|доставк|1\s*[сc]/i.test(text))) {
    return true;
  }
  if (
    openTicketCount > 0 &&
    extractOrderRef(text) &&
    text.trim().length < 30
  ) {
    return true;
  }
  if (
    openTicketCount > 0 &&
    /что\s+делать|ошибк|помогите|не\s+работ|уточн/i.test(text) &&
    text.trim().length >= 3
  ) {
    return true;
  }
  return false;
}

function needsOrderClarify(text: string, orderRef: string | null, hasMedia: boolean): boolean {
  if (isContentCatalogTask(text)) return false;
  if (hasMedia && isClientEvidenceMessage(text, true) && !NEEDS_ORDER_RE.test(text)) {
    return false;
  }
  if (!NEEDS_ORDER_RE.test(text)) return false;
  return !orderRef && !hasMedia;
}

function baseResult(partial: Partial<ClassifyResult>): ClassifyResult {
  return {
    action: "ignore",
    ticket_id: null,
    skill: "general",
    summary: "",
    order_ref: null,
    clarify_question: null,
    clarify_target: null,
    status_hint: null,
    weeek_assignee_keys: [],
    weeek_task_title: null,
    ...partial,
  };
}

export function classifyScript(input: ClassifyInput): ClassifyResult {
  const text = (input.text || "").trim();
  const compact = text.replace(/\s+/g, " ");
  const addressed = input.addressedKeys || [];

  if (SECRET_RE.test(text)) {
    return baseResult({
      action: "clarify",
      ticket_id: input.replyTicketNumber,
      skill: detectSkill(text),
      summary: text.slice(0, 200),
      order_ref: extractOrderRef(text),
      clarify_question:
        "Похоже, в сообщении есть доступы/пароли. Не присылайте секреты в чат — передайте исполнителю вне бота. Опишите проблему без паролей.",
      clarify_target: "client",
    });
  }

  if (input.chatRole === "executor" && RESOLVED_RE.test(text)) {
    return baseResult({
      action: "status_signal",
      ticket_id: input.openTickets[0]?.number ?? input.replyTicketNumber,
      summary: text,
      status_hint: "resolved",
    });
  }

  if (input.replyTicketNumber != null) {
    if (RESOLVED_RE.test(text)) {
      return baseResult({
        action: "status_signal",
        ticket_id: input.replyTicketNumber,
        summary: text,
        status_hint: "resolved",
      });
    }
    if (WAIT_CLIENT_RE.test(text)) {
      return baseResult({
        action: "status_signal",
        ticket_id: input.replyTicketNumber,
        summary: text,
        status_hint: "waiting_client",
      });
    }
    return baseResult({
      action: "append_ticket",
      ticket_id: input.replyTicketNumber,
      summary: text,
      order_ref: extractOrderRef(text),
      weeek_assignee_keys: addressed,
      weeek_task_title: addressed.length ? text.slice(0, 200) : null,
    });
  }

  if (!text && !input.hasMedia) return baseResult({});
  if (IGNORE_EXACT_RE.test(compact) && !input.hasMedia) return baseResult({});

  const openCount = input.openTickets?.length ?? 0;
  const work = isWorkMessage(text, input.hasMedia, openCount);

  // Короткое дополнение к открытому обращению (не новая тема)
  if (
    input.chatRole === "client" &&
    openCount > 0 &&
    work &&
    input.replyTicketNumber == null
  ) {
    const latest = input.openTickets[0];
    const shortFollowUp =
      text.length < 55 && /что\s+делать|ошибк|ещё|уточн|не\s+работ/i.test(text);
    const canAppend =
      latest &&
      (latest.status === "collecting" ||
        latest.status === "waiting_client" ||
        shortFollowUp);
    if (canAppend) {
      return baseResult({
        action: "append_ticket",
        ticket_id: latest.number,
        skill: detectSkill(text),
        summary: text || "Дополнение от клиента",
        order_ref: extractOrderRef(text),
      });
    }
  }

  // Обращение к сотруднику + поручение → Weeek (только если обратились)
  if (addressed.length && (work || TASK_RE.test(text))) {
    const skill = detectSkill(text);
    const orderRef = extractOrderRef(text);
    const summary = text.slice(0, 500);
    const weeekTitle =
      summary.replace(/^(стас|станислав|вика|виктория)[,:\s]+/i, "").trim() || summary;

    // Баг с заказом — уточняем, но Weeek-задачу всё равно поставим после ответа
    if (work && needsOrderClarify(text, orderRef, input.hasMedia)) {
      return baseResult({
        action: "clarify",
        skill,
        summary,
        order_ref: orderRef,
        clarify_question:
          "Пришлите номер заказа/сделки (или скрин/чек), чтобы передать исполнителю.",
        clarify_target: "client",
        weeek_assignee_keys: addressed,
        weeek_task_title: weeekTitle,
      });
    }

    // Контент/баг → ещё и TG-тикет; чистое «Стас, сделай X» → только Weeek
    return baseResult({
      action: work ? "new_ticket" : "ignore",
      skill,
      summary,
      order_ref: orderRef,
      weeek_assignee_keys: addressed,
      weeek_task_title: weeekTitle,
    });
  }

  if (input.chatRole === "client" && !work) return baseResult({});
  if (input.chatRole === "executor") return baseResult({});

  const skill = detectSkill(text);
  const orderRef = extractOrderRef(text);
  const summary =
    text ||
    (input.hasMedia
      ? "Клиент прислал скриншот/фото (ошибка или пример проблемы)"
      : "Без описания");

  if (needsOrderClarify(text, orderRef, input.hasMedia)) {
    return baseResult({
      action: "clarify",
      skill,
      summary,
      order_ref: orderRef,
      clarify_question:
        "Добрый день!\n\nПриняли обращение. Пришлите, пожалуйста, номер заказа или сделки и кратко — что именно не так (или скрин/чек).",
      clarify_target: "client",
    });
  }

  const detail = assessClientReport({
    text,
    hasMedia: input.hasMedia,
    orderRef,
    skill,
  });
  if (!detail.readyForDev && detail.clarifyQuestion) {
    return baseResult({
      action: "clarify",
      skill,
      summary,
      order_ref: orderRef,
      clarify_question: detail.clarifyQuestion,
      clarify_target: "client",
    });
  }

  return baseResult({
    action: "new_ticket",
    skill,
    summary: summary.slice(0, 500),
    order_ref: orderRef,
  });
}
