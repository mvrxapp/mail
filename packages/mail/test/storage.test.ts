import { env } from "cloudflare:test";
import type { NormalizedEmail } from "@mvrx/aecs";
import { beforeAll, describe, expect, it } from "vitest";
import { d1Init, d1Store, getMessage, getThread, listMessages } from "../src/storage.js";

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  const messageId = overrides.messageId ?? "msg-1@example.com";
  return {
    messageId,
    threadId: "thread-1@example.com",
    metadata: {
      from: { name: "Ada Lovelace", email: "ada@example.com" },
      to: [{ name: "Grace Hopper", email: "grace@example.com" }],
      cc: [],
      bcc: [],
      subject: "Hello world",
      date: "2026-01-01T00:00:00.000Z",
      timestamp: 1_767_225_600,
      ...(overrides.metadata ?? {}),
    },
    content: {
      rawFull: null,
      raw: "raw body",
      html: "<p>hi</p>",
      text: "hi",
      clean: "hi",
      forAI: "hi",
      ...(overrides.content ?? {}),
    },
    thread: {
      position: null,
      inReplyTo: null,
      references: [],
      ...(overrides.thread ?? {}),
    },
    attachments: overrides.attachments ?? [
      {
        id: `${messageId}:0`,
        filename: "note.txt",
        contentType: "text/plain",
        size: 4,
        cid: null,
        content: async () => new Uint8Array(),
        extractedText: null,
        blobKey: null,
      },
    ],
    processing: {
      processedAt: "2026-01-01T00:00:05.000Z",
      specVersion: "1.0",
      ...(overrides.processing ?? {}),
    },
  };
}

describe("storage", () => {
  beforeAll(async () => {
    await d1Init(env.DB);
  });

  it("d1Init is idempotent", async () => {
    await expect(d1Init(env.DB)).resolves.toBeUndefined();
    await expect(d1Init(env.DB)).resolves.toBeUndefined();
  });

  it("round-trips a message through d1Store/getMessage", async () => {
    const email = makeEmail({ messageId: "roundtrip-1@example.com" });
    await d1Store(env.DB, email);

    const stored = await getMessage(env.DB, email.messageId);
    expect(stored).not.toBeNull();
    expect(stored?.messageId).toBe(email.messageId);
    expect(stored?.threadId).toBe(email.threadId);
    expect(stored?.metadata.from).toEqual(email.metadata.from);
    expect(stored?.metadata.to).toEqual(email.metadata.to);
    expect(stored?.metadata.cc).toEqual(email.metadata.cc);
    expect(stored?.metadata.bcc).toEqual(email.metadata.bcc);
    expect(stored?.metadata.subject).toBe(email.metadata.subject);
    expect(stored?.metadata.timestamp).toBe(email.metadata.timestamp);
    expect(stored?.content.raw).toBe(email.content.raw);
    expect(stored?.content.html).toBe(email.content.html);
    expect(stored?.content.text).toBe(email.content.text);
    expect(stored?.content.clean).toBe(email.content.clean);
    expect(stored?.content.forAI).toBe(email.content.forAI);
    expect(stored?.content.rawFull).toBeNull(); // never stored inline
    expect(stored?.thread.inReplyTo).toBe(email.thread.inReplyTo);
    expect(stored?.thread.references).toEqual(email.thread.references);
    expect(stored?.thread.position).toBeNull(); // single-row lookup, no siblings
    expect(stored?.processing.processedAt).toBe(email.processing.processedAt);
    expect(stored?.processing.specVersion).toBe(email.processing.specVersion);

    expect(stored?.attachments).toHaveLength(1);
    expect(stored?.attachments[0].id).toBe(`${email.messageId}:0`);
    expect(stored?.attachments[0].filename).toBe("note.txt");
    expect(stored?.attachments[0].contentType).toBe("text/plain");
    expect(stored?.attachments[0].size).toBe(4);
  });

  it("returns null for a message that doesn't exist", async () => {
    const stored = await getMessage(env.DB, "does-not-exist@example.com");
    expect(stored).toBeNull();
  });

  it("falls back to processedAt for the timestamp column but preserves null on read", async () => {
    const email = makeEmail({
      messageId: "null-timestamp-1@example.com",
      metadata: {
        from: { name: "Ada Lovelace", email: "ada@example.com" },
        to: [],
        cc: [],
        bcc: [],
        subject: "No date header",
        date: null,
        timestamp: null,
      },
      attachments: [],
    });
    await d1Store(env.DB, email);

    const stored = await getMessage(env.DB, email.messageId);
    expect(stored?.metadata.timestamp).toBeNull();
    expect(stored?.metadata.date).toBeNull();
  });

  it("getThread returns messages ordered with computed position", async () => {
    const threadId = "thread-position@example.com";
    const older = makeEmail({
      messageId: "older@example.com",
      threadId,
      metadata: {
        from: { name: "Ada Lovelace", email: "ada@example.com" },
        to: [],
        cc: [],
        bcc: [],
        subject: "First",
        date: "2026-01-01T00:00:00.000Z",
        timestamp: 1_767_225_600,
      },
      attachments: [],
    } as Partial<NormalizedEmail>);
    older.threadId = threadId;

    const newer = makeEmail({
      messageId: "newer@example.com",
      threadId,
      metadata: {
        from: { name: "Ada Lovelace", email: "ada@example.com" },
        to: [],
        cc: [],
        bcc: [],
        subject: "Second",
        date: "2026-01-02T00:00:00.000Z",
        timestamp: 1_767_312_000,
      },
      attachments: [],
    } as Partial<NormalizedEmail>);
    newer.threadId = threadId;

    // Store newer first to prove getThread sorts by timestamp, not insert order.
    await d1Store(env.DB, newer);
    await d1Store(env.DB, older);

    const thread = await getThread(env.DB, threadId);
    expect(thread).toHaveLength(2);
    expect(thread[0].messageId).toBe("older@example.com");
    expect(thread[0].thread.position).toBe(0);
    expect(thread[1].messageId).toBe("newer@example.com");
    expect(thread[1].thread.position).toBe(1);
  });

  it("getThread returns an empty array for an unknown thread", async () => {
    const thread = await getThread(env.DB, "unknown-thread@example.com");
    expect(thread).toEqual([]);
  });

  it("listMessages filters by threadId and orders by timestamp", async () => {
    const threadId = "thread-list@example.com";
    const first = makeEmail({
      messageId: "list-1@example.com",
      threadId,
      metadata: {
        from: { name: "Ada Lovelace", email: "ada@example.com" },
        to: [],
        cc: [],
        bcc: [],
        subject: "List first",
        date: "2026-02-01T00:00:00.000Z",
        timestamp: 1_769_904_000,
      },
      attachments: [],
    } as Partial<NormalizedEmail>);
    first.threadId = threadId;

    const second = makeEmail({
      messageId: "list-2@example.com",
      threadId,
      metadata: {
        from: { name: "Ada Lovelace", email: "ada@example.com" },
        to: [],
        cc: [],
        bcc: [],
        subject: "List second",
        date: "2026-02-02T00:00:00.000Z",
        timestamp: 1_769_990_400,
      },
      attachments: [],
    } as Partial<NormalizedEmail>);
    second.threadId = threadId;

    await d1Store(env.DB, first);
    await d1Store(env.DB, second);

    const desc = await listMessages(env.DB, { threadId });
    expect(desc.messages.map((m) => m.messageId)).toEqual([
      "list-2@example.com",
      "list-1@example.com",
    ]);
    expect(desc.messages[0].thread.position).toBeNull(); // no siblings computed for listMessages
    expect(desc.nextCursor).toBeNull(); // both fit in one page

    const asc = await listMessages(env.DB, { threadId, order: "asc" });
    expect(asc.messages.map((m) => m.messageId)).toEqual([
      "list-1@example.com",
      "list-2@example.com",
    ]);

    // Cursor-based pagination: page through one message at a time.
    const page1 = await listMessages(env.DB, { threadId, limit: 1, order: "asc" });
    expect(page1.messages.map((m) => m.messageId)).toEqual(["list-1@example.com"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listMessages(env.DB, {
      threadId,
      limit: 1,
      order: "asc",
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.messageId)).toEqual(["list-2@example.com"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("listMessages filters by from and since/until", async () => {
    const email = makeEmail({
      messageId: "from-filter@example.com",
      threadId: "thread-from-filter@example.com",
      metadata: {
        from: { name: "Bob", email: "bob@example.com" },
        to: [],
        cc: [],
        bcc: [],
        subject: "From bob",
        date: "2026-03-01T00:00:00.000Z",
        timestamp: 1_772_323_200,
      },
      attachments: [],
    } as Partial<NormalizedEmail>);
    await d1Store(env.DB, email);

    const byFrom = await listMessages(env.DB, { from: "bob@example.com" });
    expect(byFrom.messages.some((m) => m.messageId === "from-filter@example.com")).toBe(true);

    const inRange = await listMessages(env.DB, { since: 1_772_323_200, until: 1_772_323_201 });
    expect(inRange.messages.some((m) => m.messageId === "from-filter@example.com")).toBe(true);

    const outOfRange = await listMessages(env.DB, { since: 1_772_323_201 });
    expect(outOfRange.messages.some((m) => m.messageId === "from-filter@example.com")).toBe(false);
  });
});
