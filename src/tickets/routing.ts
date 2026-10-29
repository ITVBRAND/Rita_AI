import type { Skill } from "../config/types.js";

export const defaultRouting: Record<Skill, Skill[]> = {
  payment: ["site", "onec"],
  site: ["site"],
  onec: ["onec"],
  general: ["site", "onec"],
};
