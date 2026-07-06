import { describe, expect, it, vi } from "vitest";
import {
  anthropicProvider,
  azureProvider,
  cfProvider,
  geminiProvider,
  mistralProvider,
  ollamaProvider,
  openaiCompatProvider,
  openaiProvider,
} from "../src/providers/index.js";
import type { AiMessage } from "../src/adapters.js";

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? record[key] : undefined;
}

describe("cfProvider", () => {
  it("delegates to the Workers AI binding and returns { text }", async () => {
    const fakeAi = {
      run: async (_model: string, _opts: unknown) => ({ response: "hi" }),
    } as unknown as Ai;
    const provider = cfProvider(fakeAi);
    const result = await provider.run("@cf/meta/llama-3.3-70b-instruct", [
      { role: "user", content: "hello" },
    ]);
    expect(result).toEqual({ text: "hi" });
  });
});

describe("openaiProvider", () => {
  it("posts to the OpenAI chat completions endpoint with a bearer token", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
      expect(headerValue(init, "authorization")).toBe("Bearer sk-test");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "openai reply" } }] }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = openaiProvider({ apiKey: "sk-test" });
    const result = await provider.run("gpt-4o-mini", [{ role: "user", content: "hi" }]);
    expect(result).toEqual({ text: "openai reply" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("respects a custom baseUrl", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("https://my-proxy.example.com/chat/completions");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = openaiProvider({ apiKey: "sk-test", baseUrl: "https://my-proxy.example.com" });
    await provider.run("gpt-4o-mini", [{ role: "user", content: "hi" }]);

    vi.unstubAllGlobals();
  });

  it("throws with status and body snippet on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 }))
    );
    const provider = openaiProvider({ apiKey: "sk-test" });
    await expect(provider.run("gpt-4o-mini", [{ role: "user", content: "hi" }])).rejects.toThrow(
      /400/
    );
    vi.unstubAllGlobals();
  });
});

describe("anthropicProvider", () => {
  it("posts to the Anthropic messages endpoint with x-api-key + anthropic-version", async () => {
    let capturedBody: any;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      expect(headerValue(init, "x-api-key")).toBe("anthropic-test-key");
      expect(headerValue(init, "anthropic-version")).toBe("2023-06-01");
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ content: [{ text: "anthropic reply" }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const messages: AiMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const provider = anthropicProvider({ apiKey: "anthropic-test-key" });
    const result = await provider.run("claude-haiku-4-5-20251001", messages);

    expect(result).toEqual({ text: "anthropic reply" });
    // system message must be hoisted to the top-level `system` field...
    expect(capturedBody.system).toBe("You are a helpful assistant.");
    // ...and must NOT appear in the `messages` array.
    expect(capturedBody.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(capturedBody.messages.some((m: AiMessage) => m.role === "system")).toBe(false);

    vi.unstubAllGlobals();
  });
});

describe("geminiProvider", () => {
  it("posts to the generateContent endpoint with the api key as a query param", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
      );
      expect(String(url)).toContain("key=gemini-test-key");
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "gemini reply" }] } }] }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = geminiProvider({ apiKey: "gemini-test-key" });
    const result = await provider.run("gemini-2.0-flash", [{ role: "user", content: "hi" }]);
    expect(result).toEqual({ text: "gemini reply" });

    vi.unstubAllGlobals();
  });
});

describe("mistralProvider", () => {
  it("posts to the Mistral chat completions endpoint with a bearer token", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.mistral.ai/v1/chat/completions");
      expect(headerValue(init, "authorization")).toBe("Bearer mistral-test-key");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "mistral reply" } }] }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = mistralProvider({ apiKey: "mistral-test-key" });
    const result = await provider.run("mistral-small-latest", [{ role: "user", content: "hi" }]);
    expect(result).toEqual({ text: "mistral reply" });

    vi.unstubAllGlobals();
  });
});

describe("azureProvider", () => {
  it("posts to the Azure deployment endpoint with an api-key header", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-02-15-preview"
      );
      expect(headerValue(init, "api-key")).toBe("azure-test-key");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "azure reply" } }] }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = azureProvider({
      apiKey: "azure-test-key",
      endpoint: "https://my-resource.openai.azure.com",
      deployment: "gpt-4o-mini",
    });
    const result = await provider.run("gpt-4o-mini", [{ role: "user", content: "hi" }]);
    expect(result).toEqual({ text: "azure reply" });

    vi.unstubAllGlobals();
  });
});

describe("ollamaProvider", () => {
  it("posts to the local Ollama chat endpoint by default", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://localhost:11434/api/chat");
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(false);
      return new Response(JSON.stringify({ message: { content: "ollama reply" } }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = ollamaProvider();
    const result = await provider.run("llama3.2", [{ role: "user", content: "hi" }]);
    expect(result).toEqual({ text: "ollama reply" });

    vi.unstubAllGlobals();
  });

  it("respects a custom baseUrl", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("http://ollama.internal:11434/api/chat");
      return new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = ollamaProvider({ baseUrl: "http://ollama.internal:11434" });
    await provider.run("llama3.2", [{ role: "user", content: "hi" }]);

    vi.unstubAllGlobals();
  });
});

describe("openaiCompatProvider", () => {
  it("posts to the given baseUrl and includes a bearer token when apiKey is set", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(headerValue(init, "authorization")).toBe("Bearer or-test-key");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "compat reply" } }] }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = openaiCompatProvider({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "or-test-key",
    });
    const result = await provider.run("meta-llama/llama-3.3-70b-instruct", [
      { role: "user", content: "hi" },
    ]);
    expect(result).toEqual({ text: "compat reply" });

    vi.unstubAllGlobals();
  });

  it("omits the authorization header when no apiKey is given", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(headerValue(init, "authorization")).toBeUndefined();
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = openaiCompatProvider({ baseUrl: "http://localhost:8080/v1" });
    await provider.run("local-model", [{ role: "user", content: "hi" }]);

    vi.unstubAllGlobals();
  });
});
