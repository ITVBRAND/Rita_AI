import type { ProjectRuntime, ProjectYaml, Skill } from "./types.js";

const defaultRouting: Record<Skill, Skill[]> = {
  payment: ["site", "onec"],
  site: ["site"],
  onec: ["onec"],
  general: ["site", "onec"],
};

const runtimeBySlug = new Map<string, ProjectRuntime>();

export function setProjectRuntime(yaml: ProjectYaml): ProjectRuntime {
  const runtime: ProjectRuntime = {
    slug: yaml.slug,
    name: yaml.name || yaml.slug,
    mode: yaml.mode === "ticket" ? "ticket" : "relay",
    routing: { ...defaultRouting, ...(yaml.routing || {}) },
    clientUsernames: new Set(
      (yaml.client_telegram_usernames || []).map((u) => u.replace(/^@/, "").toLowerCase()),
    ),
    clientTelegramIds: new Set(
      (yaml.client_telegram_user_ids || []).map((id) => String(id)),
    ),
    allowAdminAsClient: yaml.allow_admin_as_client !== false,
  };
  runtimeBySlug.set(yaml.slug, runtime);
  return runtime;
}

export function getProjectRuntime(slug: string): ProjectRuntime | null {
  return runtimeBySlug.get(slug) ?? null;
}
