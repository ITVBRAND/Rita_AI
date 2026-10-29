const TZ = "Europe/Moscow";

/** Календарная дата в Москве, YYYY-MM-DD. */
export function moscowYmd(now = new Date(), addDays = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  if (addDays === 0) return today;
  const [y, m, d] = today.split("-").map(Number);
  const utc = new Date(Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) + addDays));
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function formatRuDate(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  if (!y || !m || !d) return ymd;
  return `${d}.${m}.${y}`;
}

/** «сегодня», «завтра», ДД.ММ, ДД.ММ.ГГГГ, YYYY-MM-DD. */
export function parseDueDateYmd(text: string, now = new Date()): string | null {
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = text.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}|\d{2}))?\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = dmy[3] ? Number(dmy[3]) : Number(moscowYmd(now).slice(0, 4));
      if (year < 100) year += 2000;
      const mm = String(month).padStart(2, "0");
      const dd = String(day).padStart(2, "0");
      return `${year}-${mm}-${dd}`;
    }
  }

  if (/послезавтра/i.test(text)) return moscowYmd(now, 2);
  if (/завтра/i.test(text)) return moscowYmd(now, 1);
  if (/сегодня/i.test(text)) return moscowYmd(now, 0);
  return null;
}
