import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ROOT_DIR } from "../env.js";

export interface WeeekPerson {
  key: string;
  display_name: string;
  weeek_user_id: string;
  telegram_user_id: string | null;
  aliases: string[];
}

export interface WeeekPeopleConfig {
  default_project_id: number;
  people: WeeekPerson[];
}

let cached: WeeekPeopleConfig | null = null;

export function loadWeeekPeople(): WeeekPeopleConfig {
  if (cached) return cached;
  const file = path.join(ROOT_DIR, "config", "weeek-people.yaml");
  if (!fs.existsSync(file)) {
    cached = { default_project_id: 8, people: [] };
    return cached;
  }
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as WeeekPeopleConfig;
  cached = {
    default_project_id: Number(raw.default_project_id) || 8,
    people: (raw.people || []).map((p) => ({
      ...p,
      telegram_user_id: p.telegram_user_id != null ? String(p.telegram_user_id) : null,
      aliases: (p.aliases || []).map((a) => String(a).toLowerCase()),
    })),
  };
  return cached;
}

/** Кому обратились в тексте / через mention */
export function detectAddressedPeople(params: {
  text: string;
  mentionUserIds: string[];
  mentionTexts: string[];
}): WeeekPerson[] {
  const cfg = loadWeeekPeople();
  const text = params.text.toLowerCase();
  const found = new Map<string, WeeekPerson>();

  for (const person of cfg.people) {
    if (
      person.telegram_user_id &&
      params.mentionUserIds.includes(person.telegram_user_id)
    ) {
      found.set(person.key, person);
      continue;
    }
    for (const alias of person.aliases) {
      const hitMention = params.mentionTexts.some(
        (m) => m.toLowerCase().includes(alias) || alias.includes(m.toLowerCase()),
      );
      // слово целиком, чтобы «стас» не ловил случайно внутри других слов
      const re = new RegExp(`(?:^|[^\\p{L}])${escapeReg(alias)}(?:[^\\p{L}]|$)`, "iu");
      if (hitMention || re.test(text)) {
        found.set(person.key, person);
        break;
      }
    }
  }
  return [...found.values()];
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
