import type { AiChatProvider, AiMessage } from "../adapters.js";

/**
 * Pre-built AiChatProvider connectors (AECS-SDK-1 §6.2).
 *
 * Every connector is a thin `fetch` wrapper (or, for `cfProvider`, a thin
 * wrapper around the Workers AI binding) implementing the shared
 * `AiChatProvider` interface from `../adapters.js`. No new dependencies.
 */

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const snippet = await readErrorBody(res);
    throw new Error(`Request to ${url} failed with status ${res.status}: ${snippet}`);
  }
  return res.json();
}

/** Splits system messages out from the rest, joining them into a single string. */
function extractSystem(messages: AiMessage[]): { system: string; rest: AiMessage[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  return { system, rest };
}

// ── Cloudflare Workers AI ────────────────────────────────────────────────────

export function cfProvider(ai: Ai): AiChatProvider {
  return {
    async run(model, messages) {
      const result = (await ai.run(model, { messages })) as { response?: string };
      return { text: result.response ?? "" };
    },
  };
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

export function openaiProvider(options: { apiKey: string; baseUrl?: string }): AiChatProvider {
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  return {
    async run(model, messages) {
      const data = await postJson(
        `${baseUrl}/chat/completions`,
        { authorization: `Bearer ${options.apiKey}` },
        { model, messages }
      );
      return { text: data.choices?.[0]?.message?.content ?? "" };
    },
  };
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

export function anthropicProvider(options: {
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
}): AiChatProvider {
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
  const maxTokens = options.maxTokens ?? 4096;
  return {
    async run(model, messages) {
      const { system, rest } = extractSystem(messages);
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: rest.map((m) => ({ role: m.role, content: m.content })),
      };
      if (system) body.system = system;
      const data = await postJson(
        `${baseUrl}/messages`,
        { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
        body
      );
      return { text: data.content?.[0]?.text ?? "" };
    },
  };
}

// ── Google Gemini ─────────────────────────────────────────────────────────────

export function geminiProvider(options: { apiKey: string; baseUrl?: string }): AiChatProvider {
  const baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  return {
    async run(model, messages) {
      const { system, rest } = extractSystem(messages);
      const body: Record<string, unknown> = {
        contents: rest.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const data = await postJson(
        `${baseUrl}/models/${model}:generateContent?key=${options.apiKey}`,
        {},
        body
      );
      return { text: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "" };
    },
  };
}

// ── Mistral ───────────────────────────────────────────────────────────────────

export function mistralProvider(options: { apiKey: string; baseUrl?: string }): AiChatProvider {
  const baseUrl = options.baseUrl ?? "https://api.mistral.ai/v1";
  return {
    async run(model, messages) {
      const data = await postJson(
        `${baseUrl}/chat/completions`,
        { authorization: `Bearer ${options.apiKey}` },
        { model, messages }
      );
      return { text: data.choices?.[0]?.message?.content ?? "" };
    },
  };
}

// ── Azure OpenAI ──────────────────────────────────────────────────────────────

export function azureProvider(options: {
  apiKey: string;
  endpoint: string;
  deployment: string;
  apiVersion?: string;
}): AiChatProvider {
  const apiVersion = options.apiVersion ?? "2024-02-15-preview";
  return {
    async run(_model, messages) {
      const url = `${options.endpoint}/openai/deployments/${options.deployment}/chat/completions?api-version=${apiVersion}`;
      const data = await postJson(url, { "api-key": options.apiKey }, { messages });
      return { text: data.choices?.[0]?.message?.content ?? "" };
    },
  };
}

// ── Ollama ────────────────────────────────────────────────────────────────────

export function ollamaProvider(options?: { baseUrl?: string }): AiChatProvider {
  const baseUrl = options?.baseUrl ?? "http://localhost:11434";
  return {
    async run(model, messages) {
      const data = await postJson(`${baseUrl}/api/chat`, {}, { model, messages, stream: false });
      return { text: data.message?.content ?? "" };
    },
  };
}

// ── Generic OpenAI-compatible endpoint ───────────────────────────────────────

export function openaiCompatProvider(options: {
  baseUrl: string;
  apiKey?: string;
}): AiChatProvider {
  return {
    async run(model, messages) {
      const headers: Record<string, string> = {};
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      const data = await postJson(
        `${options.baseUrl}/chat/completions`,
        headers,
        { model, messages }
      );
      return { text: data.choices?.[0]?.message?.content ?? "" };
    },
  };
}
