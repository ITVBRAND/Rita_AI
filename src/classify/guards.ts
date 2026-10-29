import type { ClassifyInput, ClassifyResult } from "./types.js";
import { isClientEvidenceMessage, isContentCatalogTask } from "./contentTask.js";
import { isStockOrSyncIssue } from "./issueSummary.js";
import type { Skill } from "../config/types.js";

/** Подправляет ответ LLM/script: фото ошибки ≠ контент-задача */
export function applyClassificationGuards(
  input: ClassifyInput,
  result: ClassifyResult,
): ClassifyResult {
  const text = (input.text || "").trim();
  const evidence = isClientEvidenceMessage(text, input.hasMedia);
  const catalog = isContentCatalogTask(text);
  const stock = isStockOrSyncIssue(text);

  if (stock) {
    return {
      ...result,
      skill: /1\s*[сc]|эдо|склад/i.test(text) ? "onec" : "site",
      summary: text.slice(0, 500),
      weeek_assignee_keys: [],
      weeek_task_title: null,
    };
  }

  if (!evidence || catalog) return result;

  const catalogLikeSummary =
    /добав(ить|ь).{0,30}фото|фото.{0,20}карточк|заполн.{0,20}карточк|карточк.{0,15}товар/i.test(
      result.summary,
    );

  const incidentSummary =
    text ||
    (input.hasMedia
      ? "Клиент прислал скриншот/фото (ошибка или пример проблемы)"
      : result.summary);

  let skill: Skill = result.skill;
  if ((skill === "site" && !catalog) || catalogLikeSummary) {
    skill = /юкасс|оплат|доставк/i.test(text)
      ? "payment"
      : /1\s*[сc]|эдо|склад/i.test(text)
        ? "onec"
        : /битрикс|b24|crm|лк|смс|сайт/i.test(text)
          ? "site"
          : "general";
  }

  return {
    ...result,
    action:
      result.action === "ignore" && input.chatRole === "client" && input.hasMedia
        ? "new_ticket"
        : result.action,
    skill,
    summary: catalogLikeSummary || input.hasMedia ? incidentSummary : result.summary,
    weeek_assignee_keys: catalog ? result.weeek_assignee_keys : [],
    weeek_task_title: catalog ? result.weeek_task_title : null,
  };
}
