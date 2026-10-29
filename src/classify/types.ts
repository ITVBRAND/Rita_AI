import type { Skill } from "../config/types.js";

export type ClassifyAction =
  | "new_ticket"
  | "append_ticket"
  | "status_signal"
  | "ignore"
  | "clarify";

export interface ClassifyInput {
  text: string;
  hasMedia: boolean;
  chatRole: "client" | "executor";
  replyTicketNumber: number | null;
  openTickets: Array<{ number: number; summary: string; status: string }>;
  mentionUserIds: string[];
  mentionTexts: string[];
  /** Уже определённые обращения к сотрудникам Weeek (keys) */
  addressedKeys: string[];
}

export interface ClassifyResult {
  action: ClassifyAction;
  ticket_id: number | null;
  skill: Skill;
  summary: string;
  order_ref: string | null;
  clarify_question: string | null;
  clarify_target: "client" | "executor" | null;
  status_hint: "resolved" | "waiting_client" | "waiting_executor" | null;
  /** Создать задачу в Weeek этим людям (keys из config/weeek-people.yaml) */
  weeek_assignee_keys: string[];
  weeek_task_title: string | null;
}
