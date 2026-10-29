export type ChatRole = "client" | "executor" | "staff";
export type Skill = "site" | "onec" | "general" | "payment";

export type ProjectMode = "relay" | "ticket";

export interface ProjectYaml {
  slug: string;
  name: string;
  /** relay: клиент → краткое сообщение разработчикам без тикет-карточки */
  mode?: ProjectMode;
  client_telegram_usernames?: string[];
  client_telegram_user_ids?: Array<string | number>;
  /** Для тестов: админы могут писать от лица клиента в client-чате */
  allow_admin_as_client?: boolean;
  chats?: Array<{
    telegram_chat_id?: string | number;
    role: ChatRole;
    skill?: Skill;
    label?: string;
  }>;
  people?: Array<{
    telegram_user_id?: string | number;
    role: "client" | "executor" | "observer";
    skills?: Skill[];
    mention?: string;
  }>;
  routing?: Partial<Record<Skill, Skill[]>>;
}

export interface LoadedProject {
  slug: string;
  name: string;
  routing: Record<Skill, Skill[]>;
}

export interface ProjectRuntime {
  slug: string;
  name: string;
  mode: ProjectMode;
  routing: Record<Skill, Skill[]>;
  clientUsernames: Set<string>;
  clientTelegramIds: Set<string>;
  allowAdminAsClient: boolean;
}
