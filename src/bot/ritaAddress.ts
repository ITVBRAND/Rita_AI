/** Обращение к Rita по имени в тексте (без @). \\b в JS не работает с кириллицей. */
const RITA_NAME_RE =
  /(?:^|[^\p{L}\p{N}_])(?:маргарита|маргарите|маргариту|маргариты|маргаритой|маргаритка|марго|ритусик|риточка|ритуля|ритен|рита|рит|rita)(?=$|[^\p{L}\p{N}_])/iu;

export function textAddressesRita(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  return RITA_NAME_RE.test(raw);
}

export function textMentionsBotUsername(text: string, botUsername?: string | null): boolean {
  if (!botUsername) return false;
  const un = botUsername.replace(/^@/, "").toLowerCase();
  return new RegExp(`@${un}\\b`, "i").test(text);
}

export function isMessageToRita(text: string, botUsername?: string | null): boolean {
  return textAddressesRita(text) || textMentionsBotUsername(text, botUsername);
}
