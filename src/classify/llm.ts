import { env } from "../env.js";
import { classifyScript } from "./script.js";
import { CLASSIFY_SYSTEM } from "./prompts.js";
import { formatTeamRosterForPrompt } from "../team/loadTeam.js";
import type { ClassifyInput, ClassifyResult } from "./types.js";
import type { Skill } from "../config/types.js";

const SKILLS: Skill[] = ["site", "onec", "general", "payment"];

export async function classifyLlm(input: ClassifyInput): Promise<ClassifyResult> {
  const userPayload = {
    text: input.text,
    hasMedia: input.hasMedia,
    chatRole: input.chatRole,
    replyTicketNumber: input.replyTicketNumber,
    openTickets: input.openTickets,
    mentionUserIds: input.mentionUserIds,
    mentionTexts: input.mentionTexts,
    addressedKeysHint: input.addressedKeys,
    team_roster: formatTeamRosterForPrompt(),
  };

  try {
    const res = await fetch(`${env.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.openaiModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: CLASSIFY_SYSTEM },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("LLM error", res.status, body);
      return classifyScript(input);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content) as Partial<ClassifyResult>;
    return normalize(parsed, input);
  } catch (err) {
    console.error("LLM classify failed, fallback to script", err);
    return classifyScript(input);
  }
}

function normalize(parsed: Partial<ClassifyResult>, input: ClassifyInput): ClassifyResult {
  const fallback = classifyScript(input);
  const action = parsed.action || fallback.action;
  const skill = SKILLS.includes(parsed.skill as Skill) ? (parsed.skill as Skill) : fallback.skill;

  return {
    action,
    ticket_id:
      typeof parsed.ticket_id === "number"
        ? parsed.ticket_id
        : input.replyTicketNumber ?? fallback.ticket_id,
    skill,
    summary: (parsed.summary || fallback.summary || input.text).slice(0, 500),
    order_ref: parsed.order_ref ?? fallback.order_ref,
    clarify_question: parsed.clarify_question ?? fallback.clarify_question,
    clarify_target: parsed.clarify_target ?? fallback.clarify_target,
    status_hint: parsed.status_hint ?? fallback.status_hint,
    // Назначение в Weeek только по детектy обращения (script), не «от себя» моделью
    weeek_assignee_keys: fallback.weeek_assignee_keys,
    weeek_task_title:
      parsed.weeek_task_title ||
      fallback.weeek_task_title ||
      (fallback.weeek_assignee_keys.length
        ? (parsed.summary || input.text).slice(0, 200)
        : null),
  };
}
