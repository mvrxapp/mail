import { describe, expect, it } from "vitest";
import type { NormalizedEmail } from "@mvrx/aecs";
import { EmailThread } from "@mvrx/aecs";
import type { AiChatProvider, AiMessage, EmailTransport, OutboundEmail } from "../src/adapters.js";
import {
  compose,
  createCompose,
  draft,
  expand,
  improve,
  reply,
  replyToThread,
  shorten,
  suggestSubjects,
  tone,
  translate,
} from "../src/compose/index.js";

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    messageId: "msg-1",
    threadId: "thread-1",
    metadata: {
      from: { name: "Alice", email: "alice@example.com" },
      to: [{ name: "Bob", email: "bob@example.com" }],
      cc: [],
      bcc: [],
      subject: "Meeting Tuesday?",
      date: "2026-07-01T10:00:00Z",
      timestamp: 1751364000000,
    },
    content: {
      rawFull: null,
      raw: null,
      html: null,
      text: "Can we meet Tuesday at 2pm to discuss the invite?",
      clean: "Can we meet Tuesday at 2pm to discuss the invite?",
      forAI: "Can we meet Tuesday at 2pm to discuss the invite?",
    },
    thread: {
      position: 0,
      inReplyTo: null,
      references: [],
    },
    attachments: [],
    processing: {
      processedAt: "2026-07-01T10:00:01Z",
      specVersion: "aecs-1",
    },
    ...overrides,
  };
}

function recordingProvider(text: string) {
  const calls: { model: string; messages: AiMessage[] }[] = [];
  const provider: AiChatProvider = {
    run: async (model, messages) => {
      calls.push({ model, messages });
      return { text };
    },
  };
  return { provider, calls };
}

describe("compose.draft", () => {
  it("returns the drafted text", async () => {
    const provider: AiChatProvider = { run: async () => ({ text: "Drafted body" }) };
    const result = await draft("Write a follow-up email to Alice about the Q3 budget proposal.", provider);
    expect(result.body).toBe("Drafted body");
  });

  it("splits a 'Subject: ...' first line from the body when present", async () => {
    const provider: AiChatProvider = {
      run: async () => ({ text: "Subject: Follow-up: Q3 Budget Proposal\n\nHi Alice, following up on Monday's chat." }),
    };
    const result = await draft("Follow up with Alice about the budget.", provider);
    expect(result.subject).toBe("Follow-up: Q3 Budget Proposal");
    expect(result.body).toBe("Hi Alice, following up on Monday's chat.");
  });
});

describe("compose.reply", () => {
  it("includes the source email's content as context in the prompt", async () => {
    const email = makeEmail();
    const { provider, calls } = recordingProvider("Tuesday at 2pm works great — see you then!");
    const result = await reply(email, provider, {
      intent: "Accept the meeting invitation and suggest Tuesday at 2pm instead.",
      tone: "friendly",
    });

    expect(result.body).toBe("Tuesday at 2pm works great — see you then!");
    const userMessage = calls[0].messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain(email.content.forAI);
    expect(userMessage?.content).toContain("Accept the meeting invitation and suggest Tuesday at 2pm instead.");
    const systemMessage = calls[0].messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("Tone: friendly.");
  });

  it("includes attachment extractedText when includeAttachments is set", async () => {
    const email = makeEmail({
      attachments: [
        {
          id: "att-1",
          filename: "notes.txt",
          contentType: "text/plain",
          size: 12,
          cid: null,
          content: async () => new Uint8Array(),
          extractedText: "Q3 numbers look strong.",
        },
      ],
    });
    const { provider, calls } = recordingProvider("Thanks for the notes!");
    await reply(email, provider, { intent: "Acknowledge the attachment", includeAttachments: true });

    const userMessage = calls[0].messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("Q3 numbers look strong.");
  });
});

describe("compose.replyToThread", () => {
  it("includes the full thread context in the prompt", async () => {
    const first = makeEmail({
      messageId: "msg-1",
      metadata: {
        from: { name: "Alice", email: "alice@example.com" },
        to: [{ name: "Bob", email: "bob@example.com" }],
        cc: [],
        bcc: [],
        subject: "Project status?",
        date: "2026-07-01T10:00:00Z",
        timestamp: 1751364000000,
      },
      content: {
        rawFull: null,
        raw: null,
        html: null,
        text: "How's the project going?",
        clean: "How's the project going?",
        forAI: "How's the project going?",
      },
    });
    const second = makeEmail({
      messageId: "msg-2",
      metadata: {
        from: { name: "Bob", email: "bob@example.com" },
        to: [{ name: "Alice", email: "alice@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: Project status?",
        date: "2026-07-02T10:00:00Z",
        timestamp: 1751450400000,
      },
      content: {
        rawFull: null,
        raw: null,
        html: null,
        text: "Still working through the details.",
        clean: "Still working through the details.",
        forAI: "Still working through the details.",
      },
    });
    const thread = EmailThread.from([first, second]);
    const { provider, calls } = recordingProvider("Development is 80% complete, on track for Friday.");
    const result = await replyToThread(thread, provider, {
      intent: "Provide a status update — development is 80% complete, on track for Friday.",
      includeGreeting: true,
    });

    expect(result.body).toBe("Development is 80% complete, on track for Friday.");
    const userMessage = calls[0].messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain(thread.forAI());
    const systemMessage = calls[0].messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("Begin with an appropriate greeting.");
  });
});

describe("compose text-rewriting helpers", () => {
  it("improve returns the improved text", async () => {
    const provider: AiChatProvider = {
      run: async () => ({ text: "Could you please send me the report by Friday? It's quite urgent." }),
    };
    const result = await improve("hey can u send me the report by friday pls its quite urgent", provider);
    expect(result).toBe("Could you please send me the report by Friday? It's quite urgent.");
  });

  it("tone rewrites text and reflects the requested tone in the prompt", async () => {
    const { provider, calls } = recordingProvider("Would you mind sending over the report by Friday?");
    const result = await tone("Send me the report by Friday.", provider, { tone: "friendly" });
    expect(result).toBe("Would you mind sending over the report by Friday?");
    const systemMessage = calls[0].messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("friendly tone");
  });

  it("shorten passes the target word count through to the prompt", async () => {
    const { provider, calls } = recordingProvider("Shortened text.");
    const result = await shorten("A very long email body.", provider, { targetWords: 80 });
    expect(result).toBe("Shortened text.");
    const systemMessage = calls[0].messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("Target approximately 80 words.");
  });

  it("expand passes additional context through to the prompt", async () => {
    const { provider, calls } = recordingProvider("Expanded text.");
    const result = await expand("Brief note.", provider, {
      addContext: "This is going to a new enterprise client.",
    });
    expect(result).toBe("Expanded text.");
    const systemMessage = calls[0].messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("This is going to a new enterprise client.");
  });
});

describe("compose.suggestSubjects", () => {
  it("parses newline-delimited subject lines into a string[]", async () => {
    const provider: AiChatProvider = {
      run: async () => ({
        text: "Q3 Budget Proposal — Follow-up\nNext steps on Q3 budget\nFollowing up from Monday's meeting",
      }),
    };
    const subjects = await suggestSubjects("Hi Alice, following up on the Q3 budget proposal...", provider, {
      count: 3,
    });
    expect(subjects).toEqual([
      "Q3 Budget Proposal — Follow-up",
      "Next steps on Q3 budget",
      "Following up from Monday's meeting",
    ]);
  });

  it("parses a JSON array response into a string[]", async () => {
    const provider: AiChatProvider = {
      run: async () => ({ text: '["Subject A", "Subject B"]' }),
    };
    const subjects = await suggestSubjects("body text", provider, { count: 2 });
    expect(subjects).toEqual(["Subject A", "Subject B"]);
  });
});

describe("compose.translate", () => {
  it("returns the translated text", async () => {
    const provider: AiChatProvider = {
      run: async () => ({ text: "Hola Alice, solo quería hacer un seguimiento sobre..." }),
    };
    const result = await translate("Hi Alice, just following up on...", provider, {
      targetLanguage: "es",
      preserveFormatting: true,
    });
    expect(result).toBe("Hola Alice, solo quería hacer un seguimiento sobre...");
  });
});

describe("compose.send", () => {
  it("builds a well-formed OutboundEmail and returns the transport's messageId", async () => {
    let sentMessage: OutboundEmail | undefined;
    const transport: EmailTransport = {
      send: async (message) => {
        sentMessage = message;
        return { messageId: "m1" };
      },
    };

    const result = await compose.send(
      {
        from: { name: null, email: "support@example.com" },
        to: [{ name: "Alice", email: "alice@example.com" }],
        subject: "Re: Meeting Tuesday?",
        inReplyTo: "msg-1",
      },
      "Tuesday at 2pm works great — see you then!",
      transport
    );

    expect(result).toEqual({ messageId: "m1" });
    expect(sentMessage).toEqual({
      from: { name: null, email: "support@example.com" },
      to: [{ name: "Alice", email: "alice@example.com" }],
      subject: "Re: Meeting Tuesday?",
      inReplyTo: "msg-1",
      text: "Tuesday at 2pm works great — see you then!",
    });
  });

  it("places the body on html when format is 'html'", async () => {
    const transport: EmailTransport = { send: async () => ({ messageId: "m2" }) };
    let sentMessage: OutboundEmail | undefined;
    transport.send = async (message) => {
      sentMessage = message;
      return { messageId: "m2" };
    };

    await compose.send(
      { from: { name: null, email: "a@example.com" }, to: [{ name: null, email: "b@example.com" }], subject: "Hi" },
      "<p>Hi</p>",
      transport,
      "html"
    );

    expect(sentMessage?.html).toBe("<p>Hi</p>");
    expect(sentMessage?.text).toBeUndefined();
  });
});

describe("createCompose", () => {
  it("applies configured defaults (systemPrompt, tone, length) to compose calls", async () => {
    const { provider, calls } = recordingProvider("Improved text.");
    const myCompose = createCompose({
      systemPrompt: "You are a terse, no-nonsense email assistant.",
      defaultTone: "casual",
      defaultLength: "concise",
    });

    const result = await myCompose.improve("hey send the report pls", provider);
    expect(result).toBe("Improved text.");
    const systemMessage = calls[0].messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("You are a terse, no-nonsense email assistant.");
    expect(systemMessage?.content).toContain("Tone: casual.");
    expect(systemMessage?.content).toContain("concise and brief");
  });

  it("uses the default provider when the call omits one", async () => {
    const { provider, calls } = recordingProvider("Drafted with default provider.");
    const myCompose = createCompose({ provider });

    const result = await myCompose.draft("Follow up with Alice about invoices.");
    expect(result.body).toBe("Drafted with default provider.");
    expect(calls).toHaveLength(1);
  });
});
