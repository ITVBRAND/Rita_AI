import type { Skill } from "../config/types.js";
import {
  buildDevIssueSummary,
  shouldOpenWithGreeting,
} from "../classify/issueSummary.js";

const SKILL_HINT: Record<Skill, string> = {
  site: "сайт / Битрикс / ЛК",
  onec: "1С / склад / остатки / ЭДО",
  payment: "оплата / ЮKassa / доставка",
  general: "общее",
};

/** Скриптовый brief в стиле Вики — только факты клиента, без LLM-выдумок. */
export function formatDevRelayBriefScript(params: {
  summary: string;
  originalText: string;
  hasMedia: boolean;
  orderRef: string | null;
  skill: Skill;
  clientThread?: string;
}): string {
  const lines: string[] = [];
  const hasThread = (params.clientThread?.trim().length ?? 0) > 30;

  if (shouldOpenWithGreeting(params.clientThread)) {
    lines.push("Добрый день!", "");
  }

  const head =
    buildDevIssueSummary(params.summary).trim() || "Новое обращение от клиента";
  lines.push(head);

  if (params.orderRef) {
    lines.push("", `номер ${params.orderRef}`);
  }

  if (!hasThread) {
    const quote = params.originalText.trim();
    if (quote && quote !== head) {
      lines.push("", quote.slice(0, 1500));
    } else if (params.hasMedia) {
      lines.push("", "(клиент прислал скрин или фото документа — вложение в этот чат не пересылаю)");
    }
  }

  const hint = SKILL_HINT[params.skill];
  if (hint && params.skill !== "general") {
    lines.push("", `Тема: ${hint}`);
  }

  if (hasThread && params.clientThread?.trim()) {
    lines.push("", "Переписка с клиентом:", params.clientThread.trim().slice(0, 2500));
  }

  return lines.join("\n");
}

export async function formatDevRelayBrief(params: {
  projectName: string;
  clientLabel: string;
  summary: string;
  originalText: string;
  hasMedia: boolean;
  skill: Skill;
  orderRef: string | null;
  clientThread?: string;
}): Promise<string> {
  return formatDevRelayBriefScript(params);
}

/** @deprecated */
export function formatClientAckRelay(): string {
  return "Добрый день!\nРазбираемся";
}
