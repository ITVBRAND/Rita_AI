import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { ROOT_DIR, isBotOwner } from "../env.js";

export type TeamRole =
  | "pm"
  | "developer"
  | "designer"
  | "art_director"
  | "boss"
  | "other";

export interface TeamMember {
  key: string;
  display_name: string;
  role: TeamRole;
  role_label: string;
  telegram_user_id: string | null;
  telegram_username: string | null;
  aliases: string[];
  project_roles: Record<string, string>;
}

export interface TeamConfig {
  people: TeamMember[];
}

let cached: TeamConfig | null = null;

export function loadTeamConfig(): TeamConfig {
  if (cached) return cached;
  const file = path.join(ROOT_DIR, "config", "vbrand-team.yaml");
  const raw = yaml.parse(fs.readFileSync(file, "utf8")) as TeamConfig;
  cached = {
    people: (raw.people || []).map((p) => ({
      key: p.key,
      display_name: p.display_name,
      role: p.role,
      role_label: p.role_label || p.role,
      telegram_user_id:
        p.telegram_user_id != null ? String(p.telegram_user_id) : null,
      telegram_username: p.telegram_username?.replace(/^@/, "").toLowerCase() || null,
      aliases: (p.aliases || []).map((a) => String(a).toLowerCase()),
      project_roles: p.project_roles || {},
    })),
  };
  return cached;
}

export function resolveTeamMember(from?: {
  id?: number;
  username?: string;
}): TeamMember | null {
  if (!from) return null;
  const cfg = loadTeamConfig();
  const uid = from.id != null ? String(from.id) : null;
  const un = from.username?.toLowerCase();
  for (const p of cfg.people) {
    if (uid && p.telegram_user_id === uid) return p;
    if (un && p.telegram_username === un) return p;
    if (un && p.aliases.includes(un)) return p;
  }
  return null;
}

export function isVbrandTeamMember(from?: {
  id?: number;
  username?: string;
}): boolean {
  if (isBotOwner(from?.id)) return true;
  return resolveTeamMember(from) != null;
}

export function contentManagerMention(projectSlug?: string): string | null {
  if (!projectSlug) return null;
  const person = loadTeamConfig().people.find(
    (member) => member.project_roles[projectSlug] === "content_manager" && member.telegram_username,
  );
  return person?.telegram_username ? `@${person.telegram_username}` : null;
}

export function formatTeamRosterForPrompt(): string {
  return loadTeamConfig()
    .people.map(
      (p) =>
        `${p.display_name} (@${p.telegram_username || "—"}, id ${p.telegram_user_id || "—"}) — ${p.role_label}`,
    )
    .join("; ");
}

/** Список для ответа в чат: имя, @username и роль, без внутренних id. */
export function formatTeamDirectory(): string {
  const lines = loadTeamConfig().people.map((p) => {
    const at = p.telegram_username ? ` (@${p.telegram_username})` : "";
    return `• ${p.display_name}${at} — ${p.role_label}`;
  });
  return ["Сотрудники V-Brand:", ...lines].join("\n");
}
