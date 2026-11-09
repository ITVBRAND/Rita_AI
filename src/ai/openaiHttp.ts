import { env } from "../env.js";

const MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 25_000;

class OpenAIHttpError extends Error {
  constructor(path: string, status: number, readonly retryable: boolean) {
    super(`OpenAI ${path} failed (${status})`);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(path: string, makeBody: () => string | FormData, isForm = false): Promise<T> {
  if (!env.openaiApiKey) throw new Error("OPENAI_API_KEY is not configured");
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${env.openaiBaseUrl}/${path.replace(/^\//, "")}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.openaiApiKey}`,
          ...(isForm ? {} : { "Content-Type": "application/json" }),
        },
        body: makeBody(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      if (!response.ok) {
        const error = new OpenAIHttpError(path, response.status, isRetryableStatus(response.status));
        if (!error.retryable || attempt === MAX_RETRIES) throw error;
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10_000)
          : 400 * 2 ** attempt + Math.floor(Math.random() * 200));
        lastError = error;
        continue;
      }

      return await response.json() as T;
    } catch (error) {
      if (error instanceof OpenAIHttpError && !error.retryable) throw error;
      lastError = error;
      if (attempt === MAX_RETRIES) break;
      await delay(400 * 2 ** attempt + Math.floor(Math.random() * 200));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`OpenAI ${path} request failed`);
}

export function openaiJson<T>(path: string, body: unknown): Promise<T> {
  const normalized = path.replace(/^\//, "") === "chat/completions"
    && body !== null
    && typeof body === "object"
    && typeof (body as { model?: unknown }).model === "string"
    && /^gpt-6(?:[.-]|$)/.test((body as { model: string }).model)
    && !("reasoning_effort" in body)
    ? { ...body, reasoning_effort: "none" }
    : body;
  const serialized = JSON.stringify(normalized);
  return request<T>(path, () => serialized, false);
}

export function openaiForm<T>(path: string, makeForm: () => FormData): Promise<T> {
  return request<T>(path, makeForm, true);
}
