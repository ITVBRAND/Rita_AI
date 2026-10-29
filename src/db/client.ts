import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../env.js";

const dataDir = path.join(ROOT_DIR, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const prisma = new PrismaClient();
