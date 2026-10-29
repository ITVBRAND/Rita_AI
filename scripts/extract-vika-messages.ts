import fs from "fs";
import path from "path";

const chatsDir = path.join(process.cwd(), "chats");
const dirs = fs.readdirSync(chatsDir, { withFileTypes: true }).filter((d) => d.isDirectory());

interface VikaMsg {
  chat: string;
  text: string;
}

const all: VikaMsg[] = [];

for (const d of dirs) {
  const file = path.join(chatsDir, d.name, "messages.html");
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, "utf8");
  const chatTitle =
    html.match(/class="text bold">\s*([\s\S]*?)\s*<\/div>/)?.[1]?.replace(/\s+/g, " ").trim() ||
    d.name;

  const parts = html.split(/<div class="message default clearfix/);
  for (const part of parts.slice(1)) {
    if (!part.includes("Вика Работа")) continue;
    const from = part.match(/class="from_name">\s*([\s\S]*?)\s*<\/div>/)?.[1]?.trim();
    if (from !== "Вика Работа") continue;
    const raw = part.match(/class="text">([\s\S]*?)<\/div>/)?.[1];
    if (!raw) continue;
    const text = raw
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<a href="[^"]*">/gi, "")
      .replace(/<\/a>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (!text || text.length < 2) continue;
    all.push({ chat: chatTitle, text });
  }
}

console.log("Total Vika messages:", all.length);
const byChat = new Map<string, number>();
for (const m of all) {
  byChat.set(m.chat, (byChat.get(m.chat) || 0) + 1);
}
for (const [c, n] of byChat) console.log(`  ${c}: ${n}`);

const outPath = path.join(process.cwd(), "src", "clientVoice", "vikaExamples.json");
fs.writeFileSync(outPath, JSON.stringify(all, null, 2), "utf8");
console.log("Wrote", outPath);

// Print diverse samples (short acks, questions, long)
const short = all.filter((m) => m.text.length < 80).slice(0, 15);
console.log("\n--- Short samples ---");
short.forEach((m) => console.log(JSON.stringify(m.text)));
