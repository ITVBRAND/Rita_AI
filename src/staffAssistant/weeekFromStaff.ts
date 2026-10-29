import { isContentCatalogTask } from "../classify/contentTask.js";
import {
  createWeeekTasksForPeople,
  isWeeekEnabled,
  updateWeeekTaskDueDate,
} from "../weeek/client.js";
import { formatRuDate, parseDueDateYmd } from "../weeek/dueDate.js";
import {
  detectAddressedPeople,
  loadWeeekPeople,
  type WeeekPerson,
} from "../weeek/people.js";

const WEEEK_WORD_RE = /(?:wee?ek|\bweek\b)/i;
const TASK_VERB_RE =
  /(?:постав(?:ь|ьте|ить)|создай(?:те)?|заведи(?:те)?|добав(?:ь|ьте|ить))/iu;
const SELF_ASSIGN_RE = /(?<![\p{L}\p{N}_])мне(?![\p{L}\p{N}_])|поставь\s+мне|задачу\s+мне|мне\s+задач/iu;
const NEW_TASK_RE =
  /(?:нов(?:ую|ая)\s+задач|задач[ауеи]\s+мне|поставь\s+(?:мне\s+)?задач|создай\s+задач|в\s+(?:wee?ek|week)|назови)/iu;
const DATE_TALK_RE =
  /(?<![\p{L}])(?:дат[аеуы]|датой|дедлайн|срок)(?![\p{L}])/iu;
const DATE_WHEN_RE = /сегодня|завтра|послезавтра|\d{1,2}[./]\d{1,2}/iu;

function workBlob(text: string, thread: string): string {
  return `${thread}\n${text}`.trim();
}

/** Правка срока уже созданной задачи, а не новая карточка. */
export function isWeeekDateUpdate(text: string): boolean {
  if (NEW_TASK_RE.test(text)) return false;
  const talksDate = DATE_TALK_RE.test(text) || /только\s+дат/iu.test(text);
  if (!talksDate) return false;
  return TASK_VERB_RE.test(text) || /только/iu.test(text) || DATE_WHEN_RE.test(text);
}

export function isWeeekCreateRequest(text: string, thread = ""): boolean {
  if (isWeeekDateUpdate(text)) return false;
  const blob = workBlob(text, thread);
  const mentionsWeeek = WEEEK_WORD_RE.test(text);
  const mentionsTask = /задач/iu.test(text);
  if (
    SELF_ASSIGN_RE.test(text) &&
    (mentionsWeeek || mentionsTask) &&
    TASK_VERB_RE.test(text)
  ) {
    return true;
  }
  if (
    mentionsWeeek &&
    (TASK_VERB_RE.test(text) ||
      mentionsTask ||
      isContentCatalogTask(text) ||
      isContentCatalogTask(blob))
  ) {
    return true;
  }
  if (mentionsTask && TASK_VERB_RE.test(text)) return true;
  return false;
}

export function shouldTryStaffWeeek(text: string, thread = ""): boolean {
  return isWeeekDateUpdate(text) || isWeeekCreateRequest(text, thread);
}

export function extractWeeekTaskId(...sources: string[]): number | null {
  for (const source of sources) {
    if (!source) continue;
    const ids = [...source.matchAll(/#\s*(\d{2,})/g)].map((m) => Number(m[1]));
    const id = ids[ids.length - 1];
    if (id) return id;
  }
  return null;
}

function stripDateTail(value: string): string {
  return value
    .replace(/\s*(?:,\s*)?(?:на\s+)?(?:сегодня|завтра|послезавтра)\b.*$/i, "")
    .replace(/\s*(?:,\s*)?срок\s+до\s+\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b.*$/i, "")
    .trim();
}

function explicitTitle(text: string): string | null {
  const paren = text.match(/назов(?:и|ите)\s+е[её]\s*\(\s*([^)]{1,80})\s*\)/i);
  if (paren?.[1]?.trim()) return paren[1].trim();
  const quoted = text.match(/назов(?:и|ите)\s+е[её]\s*[«"]([^»"]{1,80})[»"]/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const plain = text.match(/назов(?:и|ите)\s+е[её]\s+([^\n,.]{1,80})/i);
  if (plain?.[1]?.trim()) return stripDateTail(plain[1].trim());
  return null;
}

function pickTitle(text: string, thread: string): string {
  const named = explicitTitle(text);
  if (named) return named.slice(0, 200);

  const lines = workBlob(text, thread)
    .split("\n")
    .map((l) => l.replace(/^user:\s*/i, "").trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const fromLine = explicitTitle(line);
    if (fromLine) return fromLine.slice(0, 200);
    if (isContentCatalogTask(line) || /задач|постав|создай|week|weeek/i.test(line)) {
      const cleaned = stripDateTail(
        line
          .replace(/^(?:да,?\s*)?(?:нужно\s*)?/i, "")
          .replace(
            /постав(?:ь|ить|ьте)?\s+(?:мне\s+)?(?:задачу\s+)?(?:в\s+)?(?:wee?ek|week)\s*/i,
            "",
          )
          .trim(),
      );
      if (cleaned.length >= 2) return cleaned.slice(0, 200);
    }
  }
  return stripDateTail(text.replace(/\s+/g, " ").trim()).slice(0, 200) || "Задача из Telegram";
}

export type StaffWeeekPlan =
  | { kind: "none" }
  | { kind: "create"; title: string; dueDate: string | null }
  | { kind: "set_due"; taskId: number | null; dueDate: string | null };

export function planStaffWeeek(params: {
  text: string;
  thread?: string;
  replyText?: string;
  now?: Date;
}): StaffWeeekPlan {
  const text = params.text;
  const thread = params.thread || "";
  const now = params.now;
  if (isWeeekDateUpdate(text)) {
    return {
      kind: "set_due",
      taskId: extractWeeekTaskId(text, params.replyText || "", thread),
      dueDate: parseDueDateYmd(text, now),
    };
  }
  if (!isWeeekCreateRequest(text, thread)) return { kind: "none" };
  return {
    kind: "create",
    title: pickTitle(text, thread),
    dueDate: parseDueDateYmd(text, now),
  };
}

export function resolveStaffWeeekAssignees(params: {
  text: string;
  thread: string;
  fromUserId: number;
  mentionUserIds: string[];
  mentionTexts: string[];
}): WeeekPerson[] {
  const addressed = detectAddressedPeople({
    text: params.text,
    mentionUserIds: params.mentionUserIds,
    mentionTexts: params.mentionTexts,
  });
  if (addressed.length) return addressed;

  const cfg = loadWeeekPeople();
  const self = cfg.people.find(
    (p) => p.telegram_user_id === String(params.fromUserId),
  );
  if (!self) return [];

  if (SELF_ASSIGN_RE.test(params.text)) return [self];
  if (WEEEK_WORD_RE.test(params.text) && isWeeekCreateRequest(params.text, params.thread)) {
    return [self];
  }
  return [];
}

export async function tryCreateWeeekFromStaffRequest(params: {
  text: string;
  thread: string;
  replyText?: string;
  fromUserId: number;
  mentionUserIds: string[];
  mentionTexts: string[];
  projectName?: string;
}): Promise<string | null> {
  const plan = planStaffWeeek(params);
  if (plan.kind === "none") return null;

  if (!isWeeekEnabled()) {
    return "Weeeek не подключён (нет WEEEK_API_TOKEN в .env).";
  }

  if (plan.kind === "set_due") {
    if (!plan.taskId) {
      return "Не вижу номер задачи Weeek. Ответьте на сообщение с номером или напишите #номер.";
    }
    if (!plan.dueDate) {
      return "Не поняла дату. Напишите «сегодня», «завтра» или ДД.ММ.ГГГГ.";
    }
    try {
      await updateWeeekTaskDueDate(plan.taskId, plan.dueDate);
      return `Поставил срок в Weeek #${plan.taskId}: ${formatRuDate(plan.dueDate)}`;
    } catch (e) {
      console.error("staff weeek update failed", e);
      return "Не удалось обновить дату в Weeek (см. логи сервера).";
    }
  }

  const people = resolveStaffWeeekAssignees(params);
  if (!people.length) {
    return "Не поняла, кому поставить задачу — обратитесь по имени или напишите «поставь мне задачу в Weeek».";
  }

  const title = plan.title;
  const dueLabel = plan.dueDate ? formatRuDate(plan.dueDate) : null;
  const description = [
    title,
    dueLabel ? `Срок: ${dueLabel}` : null,
    params.projectName ? `Проект: ${params.projectName}` : null,
    "Источник: обращение к Rita в Telegram",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const created = await createWeeekTasksForPeople({
      title: `[TG] ${title}`.slice(0, 240),
      description,
      people,
      dueDate: plan.dueDate,
    });
    const lines = created.map((c) => {
      const due = dueLabel ? `, срок ${dueLabel}` : "";
      return `• ${c.person.display_name} — задача Weeek #${c.taskId}${due}`;
    });
    return `Поставил в Weeek:\n${lines.join("\n")}`;
  } catch (e) {
    console.error("staff weeek create failed", e);
    return "Не удалось создать задачу в Weeek (см. логи сервера).";
  }
}
