/** Сводка для разработчиков только из слов клиента — без выдуманных подзадач. */

const STOCK_SYNC_RE =
  /остат|склад|синхрон|выгруз|не\s+обновля|обновля.*(?:остат|сайт|каталог)/i;

const CARD_WORD_RE = /карточк|заполн.*товар|добав.*фото.*товар/i;

export function isStockOrSyncIssue(text: string): boolean {
  return STOCK_SYNC_RE.test(text);
}

/** Убрать типичные галлюцинации LLM, если клиент этого не писал. */
export function sanitizeReplyAgainstClientFacts(
  reply: string,
  clientCorpus: string,
): string {
  const corpus = clientCorpus.toLowerCase();
  let out = reply;

  if (CARD_WORD_RE.test(out) && !CARD_WORD_RE.test(corpus)) {
    out = out
      .replace(/[^.!\n]*(?:карточк|заполн[^.!\n]*товар)[^.!\n]*[.!\n]?/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return out.trim();
}

export function buildDevIssueSummary(mergedClientText: string): string {
  const lines = mergedClientText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const dropVagueOnly = (line: string) =>
    !/^(?:на\s+)?(?:сайте\s+)?(?:есть\s+)?ошибка!?$/i.test(line) &&
    !/^rita[,!\s]/i.test(line);

  const kept = lines.filter(dropVagueOnly);
  const body = (kept.length ? kept : lines).join("\n").slice(0, 800);

  if (isStockOrSyncIssue(body)) {
    return body;
  }
  return body || mergedClientText.slice(0, 500);
}

export function stripLeadingGreeting(text: string): string {
  return text.replace(/^Добрый\s+(?:день|вечер|утро)!?\s*\n+/i, "").trim();
}

export function shouldOpenWithGreeting(clientThread?: string): boolean {
  if (!clientThread?.trim()) return true;
  const clientLines = clientThread
    .split("\n")
    .filter((l) => l.startsWith("client:")).length;
  return clientLines <= 1;
}
