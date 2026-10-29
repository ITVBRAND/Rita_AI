import type { Context } from "grammy";
import type { ChatBinding, Project } from "@prisma/client";
import type { ProjectRuntime } from "../config/types.js";

export type ProjectWithChats = Project & { chats: ChatBinding[] };

export type BotContext = Context & {
  projectInfo?: {
    binding: ChatBinding;
    project: ProjectWithChats;
    runtime: ProjectRuntime | null;
  } | null;
};
