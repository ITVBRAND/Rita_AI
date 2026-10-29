/** Номера заказов/сделок на сайте — часто 4–6 цифр */
export const ORDER_RE =
  /\b(?:заказ|сделк[аи]|номер)?\s*[#№]?\s*(\d{4,})\b/i;

const ORDER_ONLY_RE = /^[#№\s]*(\d{4,})\s*$/i;

export function extractOrderRef(text: string): string | null {
  const t = (text || "").trim();
  if (!t) return null;
  const only = t.match(ORDER_ONLY_RE);
  if (only) return only[1];
  const m = t.match(ORDER_RE);
  return m?.[1] ?? null;
}
