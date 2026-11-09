import assert from "node:assert/strict";
import { test, before, after } from "node:test";

let prisma: typeof import("../src/db/client.js").prisma;
let saveStaffUserTurn: typeof import("../src/staffAssistant/session.js").saveStaffUserTurn;
let recallEarlierTurns: typeof import("../src/staffAssistant/session.js").recallEarlierTurns;
let formatLessonsForPrompt: typeof import("../src/memory/ritaMemory.js").formatLessonsForPrompt;
let rememberLesson: typeof import("../src/memory/ritaMemory.js").rememberLesson;
let saveSharedMemory: typeof import("../src/memory/ritaMemory.js").saveSharedMemory;
let formatSharedKnowledgeForPrompt: typeof import("../src/memory/ritaMemory.js").formatSharedKnowledgeForPrompt;
let creatorForbids: typeof import("../src/memory/ritaMemory.js").creatorForbids;
let parseCreatorPolicyInstruction: typeof import("../src/memory/ritaMemory.js").parseCreatorPolicyInstruction;

before(async () => {
  ({ prisma } = await import("../src/db/client.js"));
  ({ saveStaffUserTurn, recallEarlierTurns } = await import("../src/staffAssistant/session.js"));
  ({ formatLessonsForPrompt, rememberLesson } = await import("../src/memory/ritaMemory.js"));
  ({ saveSharedMemory, formatSharedKnowledgeForPrompt, creatorForbids, parseCreatorPolicyInstruction } = await import("../src/memory/ritaMemory.js"));
});

after(async () => { await prisma.$disconnect(); });

test("Telegram update retries do not duplicate turns", async () => {
  const chat = `test-${Date.now()}`;
  const user = Math.floor(Math.random() * 1_000_000_000);
  const update = Math.floor(Math.random() * 1_000_000_000);
  assert.equal(await saveStaffUserTurn(chat, user, "повторяемое сообщение", update), true);
  assert.equal(await saveStaffUserTurn(chat, user, "повторяемое сообщение", update), false);
  assert.equal(await prisma.dialogueTurn.count({ where: { chatId: chat, userId: String(user) } }), 1);
  assert.equal(await prisma.turnMemoryIndex.count({ where: { userId: String(user) } }), 1);
});

test("keyword recall is scoped to the requesting employee", async () => {
  const chat = `test-${Date.now()}`;
  const first = Math.floor(Math.random() * 1_000_000_000);
  const second = first + 1;
  const updateBase = Math.floor(Math.random() * 1_000_000_000);
  await saveStaffUserTurn(chat, first, "По проекту Север обсудили запуск редизайна", updateBase);
  await saveStaffUserTurn(`${chat}-archive`, first, "\u041f\u043e \u043f\u0440\u043e\u0435\u043a\u0442\u0443 \u0421\u0435\u0432\u0435\u0440 \u0443\u0442\u0432\u0435\u0440\u0434\u0438\u043b\u0438 \u0441\u0440\u043e\u043a\u0438 \u0437\u0430\u043f\u0443\u0441\u043a\u0430", updateBase + 30);
  for (let i = 1; i < 14; i++) await saveStaffUserTurn(chat, first, `обычное сообщение ${i}`, updateBase + i);
  await saveStaffUserTurn(chat, second, "Секретный разговор другого сотрудника о проекте Север", updateBase + 20);
  const hits = await recallEarlierTurns(chat, first, "что обсуждали проект Север");
  assert.ok(hits.some((hit) => hit.text.includes("редизайна")));
  assert.ok(hits.every((hit) => !hit.text.includes("Секретный")));
  assert.ok(hits.some((hit) => hit.chatId === `${chat}-archive`));
});

test("explicit lessons are visible only to their owner", async () => {
  const user = String(Math.floor(Math.random() * 1_000_000_000));
  const other = String(Number(user) + 1);
  await rememberLesson("Запомни: в следующий раз сначала проверь макет", "private-chat", user);
  assert.match(await formatLessonsForPrompt(user), /проверь макет/);
  assert.doesNotMatch(await formatLessonsForPrompt(other), /проверь макет/);
});

test("exact calendar day search excludes neighboring days", async () => {
  const chatId = `date-${Date.now()}`;
  const userId = String(Math.floor(Math.random() * 1_000_000_000));
  const timezone = "Europe/Moscow";
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = fmt.format(new Date());
  const yesterday = new Date(`${today}T12:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const day = fmt.format(yesterday);
  const yesterdayAt = new Date(`${day}T12:00:00+03:00`);
  const previousDay = new Date(yesterdayAt.getTime() - 24 * 60 * 60 * 1000);
  await prisma.dialogueTurn.createMany({ data: [
    { chatId, userId, seq: 1, who: "user", text: "вчерашнее решение о макете", createdAt: yesterdayAt },
    { chatId, userId, seq: 2, who: "user", text: "позавчера другое решение", createdAt: previousDay },
  ] });
  const hits = await recallEarlierTurns(chatId, Number(userId), `что было ${day}`, timezone);
  assert.ok(hits.some((hit) => hit.text.includes("вчерашнее")));
  assert.ok(hits.every((hit) => !hit.text.includes("позавчера другое")));
});


test("shared facts are visible across employees and creator policies gate actions", async () => {
  const author = String(Math.floor(Math.random() * 1_000_000_000));
  await saveSharedMemory({ category: "project", content: "Project North launch date is May 12", createdBy: author, sourceUserId: author });
  assert.match(await formatSharedKnowledgeForPrompt(), /Project North launch date is May 12/);
  await saveSharedMemory({ category: "creator_forbid", content: "Create tasks in Weeek", createdBy: "creator" });
  assert.equal(await creatorForbids("weeek"), true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await saveSharedMemory({ category: "creator_allow", content: "Create tasks in Weeek", createdBy: "creator" });
  assert.equal(await creatorForbids("weeek"), false);
  assert.deepEqual(parseCreatorPolicyInstruction("Remember rule: you must not share passwords"), { category: "creator_forbid", content: "share passwords" });
  assert.deepEqual(parseCreatorPolicyInstruction("\u0420\u0438\u0442\u0430, \u0442\u0435\u0431\u0435 \u043d\u0435\u043b\u044c\u0437\u044f \u043f\u0435\u0440\u0435\u0441\u044b\u043b\u0430\u0442\u044c \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f"), { category: "creator_forbid", content: "\u043f\u0435\u0440\u0435\u0441\u044b\u043b\u0430\u0442\u044c \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f" });
});
