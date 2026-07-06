import { describe, expect, it, beforeEach } from "vitest";
import type { NormalizedEmail } from "@mvrx/aecs";
import type { AiChatProvider, AiMessage } from "../src/adapters.js";
import {
  summarize,
  classify,
  extractAction,
  sentiment,
  extractEntities,
  ask,
  aiTools,
} from "../src/ai-tools/index.js";

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    messageId: "msg-1",
    threadId: "thread-1",
    metadata: {
      from: { name: "Alice", email: "alice@example.com" },
      to: [{ name: "Bob", email: "bob@example.com" }],
      cc: [],
      bcc: [],
      subject: "Q3 budget proposal",
      date: "2026-07-03T10:00:00Z",
      timestamp: 1751536800000,
    },
    content: {
      rawFull: "raw-full-should-never-be-used",
      raw: null,
      html: null,
      text: "Hi Bob, the Q3 budget proposal looks great. Let's meet Thursday at 3pm.",
      clean: "Hi Bob, the Q3 budget proposal looks great. Let's meet Thursday at 3pm.",
      forAI: "Hi Bob, the Q3 budget proposal looks great. Let's meet Thursday at 3pm.",
    },
    thread: { position: 0, inReplyTo: null, references: [] },
    attachments: [],
    processing: { processedAt: "2026-07-03T10:00:01Z", specVersion: "aecs-1" },
    ...overrides,
  } as NormalizedEmail;
}

let calls: AiMessage[][];
let cannedResponse: string;
let provider: AiChatProvider;

beforeEach(() => {
  calls = [];
  cannedResponse = "default response";
  provider = {
    run: async (_model: string, messages: AiMessage[]) => {
      calls.push(messages);
      return { text: cannedResponse };
    },
  };
});

function joinedPrompt(): string {
  return calls[calls.length - 1]!.map((m) => m.content).join("\n");
}

describe("ai-tools", () => {
  it("summarize passes forAI text into the prompt and returns provider text", async () => {
    const email = makeEmail();
    cannedResponse = "Bob approved the Q3 budget and they will meet Thursday.";

    const result = await summarize(email, provider, { maxSentences: 2 });

    expect(calls).toHaveLength(1);
    expect(joinedPrompt()).toContain("Q3 budget proposal looks great");
    expect(joinedPrompt()).not.toContain("raw-full-should-never-be-used");
    expect(result).toBe("Bob approved the Q3 budget and they will meet Thursday.");
  });

  it("classify passes forAI text and parses JSON response", async () => {
    const email = makeEmail();
    cannedResponse = '{"category":"support","confidence":0.9}';

    const result = await classify(email, provider, { categories: ["sales", "support"] });

    expect(joinedPrompt()).toContain("Q3 budget proposal looks great");
    expect(joinedPrompt()).toContain("sales, support");
    expect(result).toEqual({ category: "support", confidence: 0.9 });
  });

  it("classify falls back to a sensible shape on invalid JSON", async () => {
    const email = makeEmail();
    cannedResponse = "not json at all";

    const result = await classify(email, provider, { categories: ["sales", "support"] });

    expect(result).toEqual({ category: "sales", confidence: 0 });
  });

  it("extractAction passes forAI text and parses JSON response", async () => {
    const email = makeEmail();
    cannedResponse = '{"action":"schedule_meeting","params":{"time":"15:00"}}';

    const result = await extractAction(email, provider);

    expect(joinedPrompt()).toContain("Q3 budget proposal looks great");
    expect(result).toEqual({ action: "schedule_meeting", params: { time: "15:00" } });
  });

  it("sentiment passes forAI text and parses JSON response", async () => {
    const email = makeEmail();
    cannedResponse = '{"sentiment":"positive","confidence":0.94}';

    const result = await sentiment(email, provider);

    expect(joinedPrompt()).toContain("Q3 budget proposal looks great");
    expect(result).toEqual({ sentiment: "positive", confidence: 0.94 });
  });

  it("extractEntities passes forAI text and parses JSON response", async () => {
    const email = makeEmail();
    cannedResponse = '{"people":["Bob"],"companies":[],"products":[],"amounts":["$4,200"]}';

    const result = await extractEntities(email, provider);

    expect(joinedPrompt()).toContain("Q3 budget proposal looks great");
    expect(result).toEqual({ people: ["Bob"], companies: [], products: [], amounts: ["$4,200"] });
  });

  it("ask includes the question text in the prompt and returns the answer", async () => {
    const email = makeEmail();
    cannedResponse = "The meeting is Thursday at 3pm.";

    const result = await ask(email, provider, { question: "When is the meeting?" });

    expect(joinedPrompt()).toContain("When is the meeting?");
    expect(joinedPrompt()).toContain("Q3 budget proposal looks great");
    expect(result).toBe("The meeting is Thursday at 3pm.");
  });

  it("appends attachment extractedText when includeAttachments is true", async () => {
    const email = makeEmail({
      attachments: [
        {
          id: "att-1",
          filename: "invoice.pdf",
          contentType: "application/pdf",
          size: 100,
          cid: null,
          content: async () => new Uint8Array(),
          extractedText: "Invoice total: $4,200 due July 15.",
        },
      ],
    });
    cannedResponse = "$4,200 due July 15.";

    await ask(email, provider, { question: "What is due?", includeAttachments: true });

    expect(joinedPrompt()).toContain("Invoice total: $4,200 due July 15.");
    expect(joinedPrompt()).toContain("invoice.pdf");
  });

  it("does not append attachment text when includeAttachments is not set", async () => {
    const email = makeEmail({
      attachments: [
        {
          id: "att-1",
          filename: "invoice.pdf",
          contentType: "application/pdf",
          size: 100,
          cid: null,
          content: async () => new Uint8Array(),
          extractedText: "Invoice total: $4,200 due July 15.",
        },
      ],
    });

    await summarize(email, provider);

    expect(joinedPrompt()).not.toContain("Invoice total");
  });

  it("falls back to content.clean when forAI is null", async () => {
    const email = makeEmail({
      content: {
        rawFull: null,
        raw: null,
        html: null,
        text: "plain text version",
        clean: "cleaned version used as fallback",
        forAI: null,
      },
    });

    await summarize(email, provider);

    expect(joinedPrompt()).toContain("cleaned version used as fallback");
  });

  it("exposes all tools on the aiTools namespace object", () => {
    expect(aiTools.summarize).toBe(summarize);
    expect(aiTools.classify).toBe(classify);
    expect(aiTools.extractAction).toBe(extractAction);
    expect(aiTools.sentiment).toBe(sentiment);
    expect(aiTools.extractEntities).toBe(extractEntities);
    expect(aiTools.ask).toBe(ask);
  });
});
