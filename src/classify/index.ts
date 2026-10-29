import { env } from "../env.js";
import { classifyLlm } from "./llm.js";
import { classifyScript } from "./script.js";
import { applyClassificationGuards } from "./guards.js";
import { extractOrderRef } from "./orderRef.js";
import { assessClientReport } from "./issueDetail.js";
import type { ClassifyInput, ClassifyResult } from "./types.js";

export type { ClassifyInput, ClassifyResult } from "./types.js";

export async function classify(input: ClassifyInput): Promise<ClassifyResult> {
  const raw =
    env.classifyMode === "llm" ? await classifyLlm(input) : classifyScript(input);
  let result = applyClassificationGuards(input, raw);

  // LLM иногда ошибочно ignore на тех. вопросы — подстраховка скриптом
  if (result.action === "ignore" && input.chatRole === "client") {
    const script = applyClassificationGuards(input, classifyScript(input));
    if (script.action !== "ignore") {
      result = script;
    }
  }

  const collecting = input.openTickets.find((t) => t.status === "collecting");
  const orderRef = extractOrderRef(input.text);
  if (collecting && input.chatRole === "client") {
    if (result.action === "ignore" && (orderRef || input.text.trim().length > 0)) {
      result = {
        ...result,
        action: "append_ticket",
        ticket_id: collecting.number,
        order_ref: orderRef,
        summary: result.summary || collecting.summary,
      };
    }
    if (result.action === "clarify" && orderRef) {
      result = {
        ...result,
        action: "append_ticket",
        ticket_id: collecting.number,
        order_ref: orderRef,
        clarify_question: null,
      };
    }
  }

  if (
    input.chatRole === "client" &&
    (result.action === "new_ticket" ||
      result.action === "append_ticket" ||
      result.action === "clarify") &&
    !input.hasMedia
  ) {
    const mergedText = [collecting?.summary, input.text].filter(Boolean).join("\n");
    const skill = result.skill;
    const detail = assessClientReport({
      text: mergedText || input.text,
      hasMedia: input.hasMedia,
      orderRef: result.order_ref ?? orderRef,
      skill,
    });
    if (!detail.readyForDev && detail.clarifyQuestion) {
      result = {
        ...result,
        action: "clarify",
        ticket_id: collecting?.number ?? result.ticket_id,
        clarify_question: detail.clarifyQuestion,
        clarify_target: "client",
        summary: (mergedText || result.summary || input.text).slice(0, 500),
      };
    } else if (detail.readyForDev && result.action === "clarify") {
      result = {
        ...result,
        action: collecting ? "append_ticket" : "new_ticket",
        ticket_id: collecting?.number ?? result.ticket_id,
        clarify_question: null,
        summary: (mergedText || result.summary || input.text).slice(0, 500),
      };
    }
  }

  return result;
}

export function getClassifyMode(): "script" | "llm" {
  return env.classifyMode;
}
