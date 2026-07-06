import { describe, expect, it } from "vitest";
import type { NormalizedEmail } from "@mvrx/aecs";
import { detectIntent, extractAddresses, extractDates, extractLinks, requiresReply } from "../src/tools.js";

function makeEmail(overrides: {
  from?: NormalizedEmail["metadata"]["from"];
  to?: NormalizedEmail["metadata"]["to"];
  cc?: NormalizedEmail["metadata"]["cc"];
  bcc?: NormalizedEmail["metadata"]["bcc"];
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  timestamp?: number | null;
}): NormalizedEmail {
  return {
    messageId: "msg-1",
    threadId: "thread-1",
    metadata: {
      from: overrides.from ?? { name: "Alice", email: "alice@example.com" },
      to: overrides.to ?? [{ name: "Bob", email: "bob@example.com" }],
      cc: overrides.cc ?? [],
      bcc: overrides.bcc ?? [],
      subject: overrides.subject ?? null,
      date: null,
      timestamp: overrides.timestamp ?? null,
    },
    content: {
      rawFull: null,
      raw: overrides.text ?? null,
      html: overrides.html ?? null,
      text: overrides.text ?? null,
      clean: overrides.text ?? null,
      forAI: overrides.text ?? null,
    },
    thread: {
      position: null,
      inReplyTo: null,
      references: [],
    },
    attachments: [],
    processing: {
      processedAt: "2026-07-06T00:00:00.000Z",
      specVersion: "1.0",
    },
  };
}

describe("extractAddresses", () => {
  it("de-dupes addresses across headers and body", () => {
    const email = makeEmail({
      from: { name: "Alice", email: "alice@example.com" },
      to: [{ name: "Bob", email: "bob@example.com" }],
      cc: [{ name: "Carol", email: "carol@example.com" }],
      bcc: [{ name: "Alice", email: "ALICE@example.com" }],
      text: "Loop in dave@example.com and bob@example.com on this thread.",
    });

    const addresses = extractAddresses(email);
    const emails = addresses.map((a) => a.email.toLowerCase()).sort();

    expect(emails).toEqual(["alice@example.com", "bob@example.com", "carol@example.com", "dave@example.com"]);
    // header dedupe kept only one Alice entry despite case difference
    expect(addresses.filter((a) => a.email.toLowerCase() === "alice@example.com")).toHaveLength(1);
  });
});

describe("extractLinks", () => {
  it("extracts unique http/https links from the body", () => {
    const email = makeEmail({
      text: "See the invoice at https://example.com/invoice/123 and again at https://example.com/invoice/123. Also check http://billing.example.com/pay.",
    });

    const links = extractLinks(email);
    const urls = links.map((l) => l.url).sort();

    expect(urls).toEqual(["http://billing.example.com/pay", "https://example.com/invoice/123"]);
    expect(links.every((l) => l.type === "link")).toBe(true);
  });

  it("classifies unsubscribe and tracking links", () => {
    const email = makeEmail({
      text: "Manage preferences: https://mail.example.com/unsubscribe?id=42 or track delivery at https://example.com/track/abc?utm_source=x",
    });

    const links = extractLinks(email);
    const byUrl = new Map(links.map((l) => [l.url, l.type]));

    expect(byUrl.get("https://mail.example.com/unsubscribe?id=42")).toBe("unsubscribe");
    expect(byUrl.get("https://example.com/track/abc?utm_source=x")).toBe("tracking");
  });
});

describe("extractDates", () => {
  it("finds an ISO date with a time in a sentence", () => {
    const email = makeEmail({
      text: "Let's meet on 2026-07-10 at 3pm to go over the plan.",
    });

    const dates = extractDates(email);
    expect(dates.length).toBeGreaterThan(0);

    const match = dates.find((d) => d.raw.startsWith("2026-07-10"));
    expect(match).toBeDefined();
    expect(match?.iso).toBe("2026-07-10T15:00:00.000Z");
    expect(match?.confidence).toBeGreaterThan(0.5);
  });
});

describe("requiresReply", () => {
  it("is required for a direct question", () => {
    const email = makeEmail({
      text: "Can you confirm the delivery window for tomorrow?",
    });

    const result = requiresReply(email);
    expect(result.required).toBe(true);
  });

  it("is not required for a no-reply / FYI notification", () => {
    const email = makeEmail({
      from: { name: "Billing", email: "no-reply@example.com" },
      subject: "FYI: your statement is ready",
      text: "This is an automated notification. Your monthly statement is now available.",
    });

    const result = requiresReply(email);
    expect(result.required).toBe(false);
    expect(result.urgency).toBe("low");
  });
});

describe("detectIntent", () => {
  it("classifies a direct question", () => {
    const email = makeEmail({
      text: "What time works best for you on Thursday?",
    });

    expect(detectIntent(email).type).toBe("question");
  });

  it("classifies a polite request without a question mark", () => {
    const email = makeEmail({
      text: "Please send over the signed contract by Friday.",
    });

    expect(detectIntent(email).type).toBe("request");
  });

  it("classifies an automated no-reply notification", () => {
    const email = makeEmail({
      from: { name: "Billing", email: "no-reply@example.com" },
      text: "This is an automated notification confirming your payment was received.",
    });

    expect(detectIntent(email).type).toBe("notification");
  });
});
