import type { ChatBinding, Project, Ticket } from "@prisma/client";
import { prisma } from "../db/client.js";
import { resolveExecutorSkills } from "../config/loadProjects.js";
import type { Skill } from "../config/types.js";
import { defaultRouting } from "./routing.js";

type ProjectWithChats = Project & { chats: ChatBinding[] };

export async function nextTicketNumber(projectId: string): Promise<number> {
  const last = await prisma.ticket.findFirst({
    where: { projectId },
    orderBy: { number: "desc" },
  });
  return (last?.number || 0) + 1;
}

export async function findTicketByNumber(
  projectId: string,
  number: number,
): Promise<Ticket | null> {
  return prisma.ticket.findUnique({
    where: { projectId_number: { projectId, number } },
  });
}

export async function findTicketByLinkedMessage(
  chatId: string,
  telegramMessageId: string,
): Promise<Ticket | null> {
  const link = await prisma.ticketLink.findUnique({
    where: { chatId_telegramMessageId: { chatId, telegramMessageId } },
    include: { ticket: true },
  });
  return link?.ticket ?? null;
}

export async function listOpenTickets(projectId: string) {
  return prisma.ticket.findMany({
    where: {
      projectId,
      status: { notIn: ["resolved", "cancelled"] },
    },
    orderBy: { number: "desc" },
    take: 15,
  });
}

export function pickExecutorChats(
  project: ProjectWithChats,
  skill: Skill,
): ChatBinding[] {
  const wanted = new Set(resolveExecutorSkills(skill, defaultRouting));
  const executors = project.chats.filter((c) => c.role === "executor");
  const matched = executors.filter(
    (c) => wanted.has(c.skill as Skill) || (skill === "general" && c.skill === "general"),
  );
  if (matched.length > 0) return matched;
  // payment/general → all executor chats if no skill match
  if (skill === "payment" || skill === "general") return executors;
  const bySkill = executors.filter((c) => c.skill === skill);
  return bySkill.length ? bySkill : executors;
}

export async function createTicket(params: {
  project: ProjectWithChats;
  skill: Skill;
  summary: string;
  orderRef: string | null;
  clientChatId: string;
  openedByUserId: string | null;
  status?: string;
}) {
  const number = await nextTicketNumber(params.project.id);
  const executors = pickExecutorChats(params.project, params.skill);
  return prisma.ticket.create({
    data: {
      number,
      projectId: params.project.id,
      status: params.status || "open",
      skill: params.skill,
      summary: params.summary,
      orderRef: params.orderRef,
      clientChatId: params.clientChatId,
      executorChatIds: JSON.stringify(executors.map((e) => e.chatId)),
      openedByUserId: params.openedByUserId,
    },
  });
}

export async function appendMessage(params: {
  ticketId: string;
  direction: "client" | "executor" | "bot";
  telegramMessageId: string;
  chatId: string;
  fromUserId: string | null;
  text: string;
  hasMedia: boolean;
}) {
  return prisma.ticketMessage.create({ data: params });
}

export async function addLink(params: {
  ticketId: string;
  chatId: string;
  telegramMessageId: string;
  kind: "card" | "client_ack" | "clarify" | "relay";
}) {
  return prisma.ticketLink.create({ data: params });
}

export async function setTicketStatus(
  ticketId: string,
  status: string,
  resolution?: string,
): Promise<Ticket> {
  return prisma.ticket.update({
    where: { id: ticketId },
    data: {
      status,
      resolvedAt: status === "resolved" ? new Date() : undefined,
      resolution: resolution ? resolution.slice(0, 500) : undefined,
    },
  });
}

export async function getRecentMessages(ticketId: string, take = 8) {
  return prisma.ticketMessage.findMany({
    where: { ticketId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export function parseExecutorChatIds(ticket: Ticket): string[] {
  try {
    const parsed = JSON.parse(ticket.executorChatIds) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
