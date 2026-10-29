import type { Ticket } from "@prisma/client";

const STATUS_RU: Record<string, string> = {
  collecting: "сбор данных",
  open: "открыт",
  waiting_client: "ждём клиента",
  waiting_executor: "ждём исполнителя",
  resolved: "решён",
  cancelled: "отменён",
};

export function ticketTag(number: number): string {
  return `#T-${number}`;
}

export function formatTicketCard(ticket: Ticket, projectName: string): string {
  const lines = [
    `🎫 ${ticketTag(ticket.number)} · ${projectName}`,
    `Статус: ${STATUS_RU[ticket.status] || ticket.status}`,
    `Направление: ${ticket.skill}`,
  ];
  if (ticket.orderRef) lines.push(`Заказ/сделка: ${ticket.orderRef}`);
  lines.push("", ticket.summary);
  lines.push("", "↩️ Ответьте reply на это сообщение, чтобы добавить контекст.");
  lines.push("Команды: /resolve " + ticket.number + " · /ticket " + ticket.number);
  return lines.join("\n");
}

export function formatClientAck(ticket: Ticket): string {
  return `Поняла, взяла в работу (тикет ${ticketTag(ticket.number)}). Передала команде.`;
}

export function formatResolvedNotice(ticket: Ticket): string {
  return `Тикет ${ticketTag(ticket.number)} закрыт как решённый.`;
}

export function formatStatus(ticket: Ticket): string {
  return [
    `${ticketTag(ticket.number)} — ${STATUS_RU[ticket.status] || ticket.status}`,
    `skill: ${ticket.skill}`,
    ticket.orderRef ? `order: ${ticket.orderRef}` : null,
    "",
    ticket.summary,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

export function parseTicketNumberFromText(text: string): number | null {
  const m = text.match(/#T-(\d+)/i);
  if (!m) return null;
  return Number(m[1]);
}
