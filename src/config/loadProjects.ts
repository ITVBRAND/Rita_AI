import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ROOT_DIR } from "../env.js";
import { prisma } from "../db/client.js";
import type { LoadedProject, ProjectYaml, Skill } from "./types.js";
import { getProjectRuntime, setProjectRuntime } from "./projectRuntime.js";

const defaultRouting: Record<Skill, Skill[]> = {
  payment: ["site", "onec"],
  site: ["site"],
  onec: ["onec"],
  general: ["site", "onec"],
};

export async function syncProjectsFromYaml(): Promise<LoadedProject[]> {
  const dir = path.join(ROOT_DIR, "config", "projects");
  if (!fs.existsSync(dir)) return [];

  const loaded: LoadedProject[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const yaml = parseYaml(raw) as ProjectYaml;
    if (!yaml?.slug) continue;

    const routing = { ...defaultRouting, ...(yaml.routing || {}) };
    const project = await prisma.project.upsert({
      where: { slug: yaml.slug },
      create: { slug: yaml.slug, name: yaml.name || yaml.slug },
      update: { name: yaml.name || yaml.slug },
    });

    for (const chat of yaml.chats || []) {
      const chatId = chat.telegram_chat_id != null ? String(chat.telegram_chat_id) : "";
      if (!chatId || chatId.startsWith("REPLACE") || chatId === "0") continue;
      await prisma.chatBinding.upsert({
        where: { projectId_chatId: { projectId: project.id, chatId } },
        create: {
          projectId: project.id,
          chatId,
          role: chat.role,
          skill: chat.skill || "general",
          label: chat.label || "",
        },
        update: {
          role: chat.role,
          skill: chat.skill || "general",
          label: chat.label || "",
        },
      });
    }

    setProjectRuntime(yaml);
    loaded.push({ slug: yaml.slug, name: yaml.name || yaml.slug, routing });
  }
  return loaded;
}

export async function getProjectByChatId(chatId: string) {
  const binding = await prisma.chatBinding.findFirst({
    where: { chatId },
    include: { project: { include: { chats: true } } },
  });
  if (!binding) return null;
  const runtime = getProjectRuntime(binding.project.slug);
  return { binding, project: binding.project, runtime };
}

export function getExecutorChats(project: { chats: Array<{ role: string; chatId: string }> }) {
  return project.chats.filter((c) => c.role === "executor");
}

export function resolveExecutorSkills(
  skill: Skill,
  routing: Record<Skill, Skill[]> = defaultRouting,
): Skill[] {
  return routing[skill] || routing.general || ["general"];
}
