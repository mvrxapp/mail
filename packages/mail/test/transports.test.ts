import { describe, expect, it, vi } from "vitest";
import type { OutboundEmail } from "../src/adapters.js";

// "cloudflare:email" only resolves inside the Workers runtime / vitest-pool-workers.
// cfTransport imports it lazily (dynamic import inside `send()`), so mocking it here
// lets us exercise the full cfTransport path under plain Node/vitest without a real
// Email binding or a live network.
vi.mock("cloudflare:email", () => {
  class EmailMessage {
    readonly from: string;
    readonly to: string;
    readonly raw: string;
    constructor(from: string, to: string, raw: string) {
      this.from = from;
      this.to = to;
      this.raw = raw;
    }
  }
  return { EmailMessage };
});

const { buildMime, cfTransport } = await import("../src/transports/index.js");
const { sendEmail } = await import("../src/send.js");

const baseMessage: OutboundEmail = {
  from: { name: "Support", email: "support@example.com" },
  to: [{ name: "Ada Lovelace", email: "ada@example.com" }],
  subject: "Re: Your ticket",
  text: "Thanks for reaching out.",
};

describe("buildMime", () => {
  it("includes From/To/Subject/Message-ID headers", () => {
    const raw = buildMime(baseMessage, "<abc123@example.com>");

    expect(raw).toContain('From: Support <support@example.com>');
    expect(raw).toContain('To: Ada Lovelace <ada@example.com>');
    expect(raw).toContain("Subject: Re: Your ticket");
    expect(raw).toContain("Message-ID: <abc123@example.com>");
    expect(raw).toContain("MIME-Version: 1.0");
  });

  it("uses CRLF line endings between headers and body", () => {
    const raw = buildMime(baseMessage, "<abc123@example.com>");
    expect(raw).toContain("\r\n\r\n");
    expect(raw).not.toMatch(/[^\r]\n/);
  });

  it("includes Cc when provided", () => {
    const raw = buildMime(
      { ...baseMessage, cc: [{ name: null, email: "cc@example.com" }] },
      "<abc123@example.com>"
    );
    expect(raw).toContain("Cc: cc@example.com");
  });

  it("includes In-Reply-To and References when provided", () => {
    const raw = buildMime(
      {
        ...baseMessage,
        inReplyTo: "<parent@example.com>",
        references: ["<root@example.com>", "<parent@example.com>"],
      },
      "<abc123@example.com>"
    );
    expect(raw).toContain("In-Reply-To: <parent@example.com>");
    expect(raw).toContain("References: <root@example.com> <parent@example.com>");
  });

  it("omits In-Reply-To and References when absent", () => {
    const raw = buildMime(baseMessage, "<abc123@example.com>");
    expect(raw).not.toContain("In-Reply-To:");
    expect(raw).not.toContain("References:");
  });

  it("builds multipart/alternative when both text and html are present", () => {
    const raw = buildMime({ ...baseMessage, html: "<p>Thanks</p>" }, "<abc123@example.com>");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("Content-Type: text/plain");
    expect(raw).toContain("Content-Type: text/html");
    expect(raw).toContain("Thanks for reaching out.");
    expect(raw).toContain("<p>Thanks</p>");
  });

  it("builds multipart/mixed with base64 attachments when present", () => {
    const raw = buildMime(
      {
        ...baseMessage,
        attachments: [
          { filename: "note.txt", contentType: "text/plain", content: new TextEncoder().encode("hello") },
        ],
      },
      "<abc123@example.com>"
    );
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain('filename="note.txt"');
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    expect(raw).toContain(btoa("hello"));
  });
});

describe("cfTransport", () => {
  it("sends via the binding and returns a generated messageId", async () => {
    let captured: unknown;
    const binding = {
      send: async (msg: unknown) => {
        captured = msg;
      },
    } as unknown as SendEmail;

    const transport = cfTransport(binding);
    const result = await transport.send(baseMessage);

    expect(result.messageId).toMatch(/^<.+@example\.com>$/);
    expect(captured).toMatchObject({
      from: "support@example.com",
      to: "ada@example.com",
    });
    const raw = (captured as { raw: string }).raw;
    expect(raw).toContain("From: Support <support@example.com>");
    expect(raw).toContain("To: Ada Lovelace <ada@example.com>");
    expect(raw).toContain(`Message-ID: ${result.messageId}`);
  });
});

describe("sendEmail", () => {
  it("delegates to the transport and returns its result", async () => {
    let received: OutboundEmail | undefined;
    const transport = {
      send: async (message: OutboundEmail) => {
        received = message;
        return { messageId: "x" };
      },
    };

    const result = await sendEmail(baseMessage, transport);

    expect(result).toEqual({ messageId: "x" });
    expect(received).toBe(baseMessage);
  });
});
