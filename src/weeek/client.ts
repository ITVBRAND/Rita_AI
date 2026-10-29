import { env } from "../env.js";
import { loadWeeekPeople, type WeeekPerson } from "./people.js";

const BASE = "https://api.weeek.net/public/v1";

export function isWeeekEnabled(): boolean {
  return Boolean(env.weeekApiToken);
}

async function weeekFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!env.weeekApiToken) throw new Error("WEEEK_API_TOKEN is not set");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.weeekApiToken}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const data = (await res.json()) as T & { success?: boolean; message?: string };
  if (!res.ok || (data as { success?: boolean }).success === false) {
    throw new Error(`Weeek API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function createWeeekTask(params: {
  title: string;
  description?: string;
  assignee: WeeekPerson;
  projectId?: number;
  dueDate?: string | null;
}): Promise<{ id: number }> {
  const projectId = params.projectId ?? loadWeeekPeople().default_project_id;
  const body: Record<string, unknown> = {
    title: params.title.slice(0, 240),
    description: params.description || "",
    projectId,
    userId: params.assignee.weeek_user_id,
    type: "action",
  };
  if (params.dueDate) body.dueDate = params.dueDate;
  const data = await weeekFetch<{ success: boolean; task: { id: number } }>(
    "/tm/tasks",
    { method: "POST", body: JSON.stringify(body) },
  );
  return { id: data.task.id };
}

export async function updateWeeekTaskDueDate(
  taskId: number,
  dueDate: string,
): Promise<void> {
  await weeekFetch(`/tm/tasks/${taskId}`, {
    method: "PUT",
    body: JSON.stringify({ dueDate }),
  });
}

export async function createWeeekTasksForPeople(params: {
  title: string;
  description?: string;
  people: WeeekPerson[];
  projectId?: number;
  dueDate?: string | null;
}): Promise<Array<{ person: WeeekPerson; taskId: number }>> {
  const out: Array<{ person: WeeekPerson; taskId: number }> = [];
  for (const person of params.people) {
    const task = await createWeeekTask({
      title: params.title,
      description: params.description,
      assignee: person,
      projectId: params.projectId,
      dueDate: params.dueDate,
    });
    out.push({ person, taskId: task.id });
  }
  return out;
}
