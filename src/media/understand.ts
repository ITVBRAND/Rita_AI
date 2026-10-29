import { env } from "../env.js";
import type { BotContext } from "../bot/context.js";

const MAX_BYTES = 8 * 1024 * 1024;

const VISION_PROMPT = `Это сообщение клиента техподдержке. На картинке может быть скрин ошибки.
Кратко по-русски: что на экране, дословный текст ошибки, код (404, 500 и т.п.) и адрес страницы, если они видны.
Не выдумывай то, чего нет на изображении. 2–6 предложений.`;

async function downloadTelegramFile(fileId: string): Promise<Buffer | null> {
  if (!env.botToken) return null;
  const metaRes = await fetch(
    `https://api.telegram.org/bot${env.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!metaRes.ok) return null;
  const meta = (await metaRes.json()) as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
  const filePath = meta.result?.file_path;
  const size = meta.result?.file_size ?? 0;
  if (!meta.ok || !filePath || size > MAX_BYTES) return null;
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${env.botToken}/${filePath}`,
  );
  if (!fileRes.ok) return null;
  const buf = Buffer.from(await fileRes.arrayBuffer());
  if (buf.length > MAX_BYTES) return null;
  return buf;
}

async function readScreenshot(image: Buffer, mime: string): Promise<string | null> {
  const dataUrl = `data:${mime};base64,${image.toString("base64")}`;
  const res = await fetch(`${env.openaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.openaiModel,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    console.error("screenshot read failed", res.status, await res.text());
    return null;
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  return text ? `[скрин] ${text}` : null;
}

async function transcribeAudio(audio: Buffer, filename: string, mime: string): Promise<string | null> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), filename);
  form.append("model", "whisper-1");
  form.append("language", "ru");
  const res = await fetch(`${env.openaiBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openaiApiKey}` },
    body: form,
  });
  if (!res.ok) {
    console.error("voice transcription failed", res.status, await res.text());
    return null;
  }
  const data = (await res.json()) as { text?: string };
  const text = data.text?.trim();
  return text ? `[голосовое] ${text}` : null;
}

type MediaCarrier = {
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string; mime_type?: string };
  voice?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; mime_type?: string; file_name?: string };
  video_note?: { file_id: string };
};

/** Текст со скрина или расшифровка голосового. Пусто, если распознать нечего или не вышло. */
export async function understandMessageMedia(
  msg: MediaCarrier | undefined | null,
): Promise<string | null> {
  if (!env.openaiApiKey || !msg) return null;

  try {
    const photo = msg.photo?.at(-1);
    if (photo) {
      const image = await downloadTelegramFile(photo.file_id);
      return image ? await readScreenshot(image, "image/jpeg") : null;
    }

    if (msg.document?.mime_type && /^image\//i.test(msg.document.mime_type)) {
      const image = await downloadTelegramFile(msg.document.file_id);
      return image ? await readScreenshot(image, msg.document.mime_type) : null;
    }

    if (msg.voice) {
      const audio = await downloadTelegramFile(msg.voice.file_id);
      return audio ? await transcribeAudio(audio, "voice.ogg", msg.voice.mime_type || "audio/ogg") : null;
    }

    if (msg.audio) {
      const audio = await downloadTelegramFile(msg.audio.file_id);
      const name = msg.audio.file_name || "audio.mp3";
      return audio ? await transcribeAudio(audio, name, msg.audio.mime_type || "audio/mpeg") : null;
    }

    if (msg.video_note) {
      const audio = await downloadTelegramFile(msg.video_note.file_id);
      return audio ? await transcribeAudio(audio, "video.mp4", "video/mp4") : null;
    }
  } catch (e) {
    console.error("understand media failed", e);
  }
  return null;
}

export async function understandClientMedia(ctx: BotContext): Promise<string | null> {
  return understandMessageMedia(ctx.message);
}
