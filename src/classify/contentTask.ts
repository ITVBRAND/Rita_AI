/** Явная задача по каталогу: добавить/заполнить товар или фото в карточке. */
const CONTENT_CATALOG_RE =
  /((?:добав|заполн|вылож|загруз|постав|обнов)(?:ить|ьте|ь|и)).{0,50}(фото|картинк|изображен).{0,40}(карточк|товар|каталог|сайт)|(карточк[ауы]?\s+товар)|заполн\w{0,8}.{0,30}товар|добав\w{0,8}.{0,30}товар|вылож\w{0,8}.{0,30}товар|описан\w{0,8}.{0,25}товар|заполн.{0,25}карточк.{0,25}(товар|сайт)|(?:обнов).{0,25}(фото|картинк).{0,25}(карточк|товар)|фото.{0,40}товар|товар.{0,40}фото|нов\w{0,8}\s+товар|контент/i;

const STOCK_SYNC_RE =
  /остат|склад|синхрон|выгруз|не\s+обновля|обновля.*(?:остат|сайт)/i;

/** Скрин/фото как доказательство бага у клиента */
export const CLIENT_EVIDENCE_RE =
  /скрин|скриншот|ошибк|exception|error|баг|не\s+работает|клиент|пример|вот\s+так|смотрите|прикреп|чек|расхожд|не\s+открыва|не\s+заходит|остат|не\s+обновля/i;

export function isContentCatalogTask(text: string): boolean {
  const t = text.trim();
  if (STOCK_SYNC_RE.test(t)) return false;
  if (/ошибк|не\s+работает|баг|не\s+открыва/i.test(t) && !/заполн|добав|вылож|карточк/i.test(t)) {
    return false;
  }
  return CONTENT_CATALOG_RE.test(t);
}

export function isClientEvidenceMessage(text: string, hasMedia: boolean): boolean {
  if (!hasMedia) return CLIENT_EVIDENCE_RE.test(text);
  if (CLIENT_EVIDENCE_RE.test(text)) return true;
  // Фото/файл без явной контент-задачи — почти всегда скрин проблемы, не «добавить в каталог»
  return !isContentCatalogTask(text);
}
