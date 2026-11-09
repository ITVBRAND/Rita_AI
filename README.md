# Rita — Telegram PM Bot

## Память диалогов

Internal staff dialogue is persisted in `DialogueTurn` with Telegram `update_id`; repeated updates are ignored. Search covers the requesting employee's chats and ranks messages lexically, with semantic embedding search when `OPENAI_API_KEY` is set. Results include date and source chat id. Data remains isolated by Telegram user id.

- `/memory` — список сохранённых правил;
- `/memory search <тема или дата>` — найти сообщения своей переписки;
- `/memory add <правило>` — вручную сохранить правило;
- `/memory source <id>` — посмотреть первоисточник, если он связан;
- `/memory delete <id>` — деактивировать неверное правило.

Explicit ?remember this? requests are still stored as rules. The assistant also extracts other supported, reusable work facts automatically; the model itself is not retrained.

### Automatic facts and semantic search

When `OPENAI_API_KEY` is set, new staff and Rita messages enter a durable queue. A batch worker builds embeddings and extracts supported work facts such as project context, decisions, commitments, preferences, and rules, with links to their source turns. This does not retrain the model: facts are stored in PostgreSQL and supplied as context when Rita replies. Failed API requests remain queued for retry.

Indexes and searches are limited to the requesting Telegram user, across that user's chats. `/memory search <query>` performs semantic search and shows the source chat id. Run `/memory index` in a private chat to enqueue older history; backfill proceeds in small batches during later conversations. Without `OPENAI_API_KEY`, word search remains available, but automatic extraction and semantic search are disabled.

Shared work facts extracted from staff conversations are available to all staff members; employee-specific memories remain private. The bot creator can manage global facts and rules in a private chat with `/teach fact <fact>`, `/teach allow <capability>`, and `/teach forbid <capability>`. Rules can also be taught in natural language, for example: ?Rita, remember rule: you must not forward client messages.? Use `/teach list` and `/teach remove <id>` to review or remove shared records. `/teach index` queues historical conversations from all staff accounts for shared fact extraction. `/memory shared` lists the common memory. Set `OPENAI_EMBEDDING_MODEL` to choose another embedding model; the default is `text-embedding-3-small`.

`npm test` создаёт отдельную временную SQLite базу в `prisma/rita-memory-test.db`, запускает тесты и удаляет её.

### Общая база документов

Создатель бота может отправить Rita PDF или DOCX в личном чате. Текст извлекается, разбивается на фрагменты и индексируется для семантического поиска; исходные файлы не сохраняются. Релевантные отрывки добавляются к ответу с именем файла как источником.

- `/docs list` — список загруженных документов;
- `/docs remove <id>` — исключить документ из поиска;
- `/docs` — подсказка по загрузке.

Загрузка ограничена 20 МБ возможностями скачивания Telegram Bot API. Сканированные PDF без текстового слоя пока требуют OCR и не индексируются.

### Группировка сообщений и защита от спама

В обращениях к staff-ассистенту сообщения одного сотрудника в одном чате, отправленные в пределах двух секунд, объединяются в один запрос. Общий лимит — 30 входящих сообщений на пользователя в минуту; для запросов к staff-ассистенту действует более строгий лимит 12 сообщений в минуту. Лимит хранится в памяти процесса и сбрасывается при перезапуске.

Проектный менеджер в Telegram: несколько групп на проект, тикеты, маршрутизация клиент → исполнители. По умолчанию работает **по скрипту**; если задан `OPENAI_API_KEY` — классификация через LLM.

## Быстрый старт (локально)

1. Создайте бота у [@BotFather](https://t.me/BotFather) → получите `BOT_TOKEN`.
2. Узнайте свой Telegram user id (например [@userinfobot](https://t.me/userinfobot)).
3. Скопируйте env:

```bash
cp .env.example .env
```

Заполните:

```env
BOT_TOKEN=123:ABC...
ADMIN_USER_IDS=YOUR_TELEGRAM_USER_ID
DATABASE_URL=postgresql://rita_app:change-me@localhost:5432/rita_pm?schema=public
# опционально:
# OPENAI_API_KEY=
```

4. Установите зависимости и БД:

```bash
npm install
npx prisma generate
npm run db:deploy
```

5. Запуск:

```bash
npm run dev
```

В логе должно быть: `classify mode: script` (или `llm`).

## Подключение к проектам

1. Добавьте бота **админом** во все группы проекта (клиентская + исполнители).
2. В @BotFather для бота включите **Group Privacy → Turn off** (иначе бот не видит обычные сообщения).
3. В каждой группе от вашего аккаунта (admin):

```text
/bind newarmor client
/bind newarmor executor site
/bind newarmor executor onec
```

4. Проверка: `/projects`

Пилотный slug: `newarmor` (`config/projects/newarmor.yaml`). Новый проект — новый YAML + `/bind`.

## Как пользоваться (режим relay — две группы)

В `config/projects/newarmor.yaml`: `mode: relay`, клиент `@Vitaly_Simonyak`.

1. `/bind newarmor client` — группа с клиентом  
2. `/bind newarmor executor` — группа разработчиков (одна)

- Клиент (или админ в тесте) пишет проблему → бот отвечает «Принято, передали разработчикам» и шлёт в dev-чат **сформулированную суть** + цитату клиента + копию вложения (без тикет-карточки).
- Разработчик **reply** на это сообщение → текст уходит клиенту.
- Сообщения сотрудников в client-чате (не клиент) бот игнорирует.
- `/ticket` / `/resolve` — внутренний учёт для админов (клиенту номера тикетов не показываем).

## Голос «Вика Работа»

Ответы клиенту и формулировки для разработчиков опираются на экспорты в `chats/` (Telegram Desktop). После обновления переписок:

```bash
npm run vika:extract
```

Примеры попадают в `src/clientVoice/vikaExamples.json`; промпты — в `src/clientVoice/vikaStyle.ts`.


В `.env` укажи ключ **Platform API** (не ChatGPT Plus):

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

После перезапуска в логе: `classify mode: llm`. Без ключа работает script-режим.

## Weeek (задачи сотрудникам)

Токен workspace → `WEEEK_API_TOKEN`. Люди и алиасы: [`config/weeek-people.yaml`](config/weeek-people.yaml).

Задача в Weeek создаётся **только при обращении** (имя / @):

- `Стас, нужно добавить фото в карточку` → Weeek на Станислава + TG-тикет
- `Нужно заполнить карточку на сайте` → только TG, **без** Weeek

Проект по умолчанию: NEW ARMOR (`default_project_id: 8`).

## Деплой на облачный сервер

Кратко: VPS (Ubuntu) + Node 20 + systemd + long polling.

1. Залейте код на сервер (`git clone` или `scp`).
2. На сервере: `npm ci`, скопируйте `.env`, `npx prisma generate && npx prisma db push`.
3. `npm run build && npm start` (или systemd unit, см. ниже).
4. Откройте исходящий HTTPS к `api.telegram.org` (входящий порт для polling не нужен).

Пример `systemd` unit `/etc/systemd/system/rita-pm.service`:

```ini
[Unit]
Description=Rita PM Telegram Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/rita-pm
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/rita-pm/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now rita-pm
sudo journalctl -u rita-pm -f
```

Альтернативы: Docker, Railway/Render (нужен всегда-on процесс), webhook + reverse proxy — позже.

## Команды

| Команда | Кто | Описание |
|---------|-----|----------|
| `/start` | все | справка + режим classify |
| `/projects` | admin | список проектов и chat_id |
| `/bind <slug> <client\|executor> [skill]` | admin | привязать текущий чат |
| `/unbind <chat_id>` | creator, private chat | удалить привязку проекта, сохранив бота в Telegram-группе |
| `/access add <telegram_user_id>` | admin, private chat | разрешить пользователю общаться с Ритой в личке |
| `/access remove <telegram_user_id>` | admin, private chat | отозвать разрешение на личные сообщения |
| `/access list` | admin, private chat | показать пользователей из списка доступа |
| `/ticket <n>` | участники | статус и последние сообщения |
| `/resolve <n>` | участники | закрыть тикет |
| `/open <n>` | участники | снова открыть |
