import { env } from "cloudflare:test";
import type { NormalizedEmail } from "@mvrx/aecs";
import { beforeAll, describe, expect, it } from "vitest";
import type { EmailTransport, OutboundEmail } from "../src/adapters.js";
import { d1Init } from "../src/storage.js";
import {
  deleteRule,
  evaluateRules,
  loadRules,
  saveRule,
  type Rule,
} from "../src/rules/index.js";

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
    attachments: overrides.attachments ?? [],
    processing: {
      processedAt: "2026-01-01T00:00:05.000Z",
      specVersion: "1.0",
      ...(overrides.processing ?? {}),
    },
  };
}

function makeTransport(): { transport: EmailTransport; sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = [];
  const transport: EmailTransport = {
    send: async (message) => {
      sent.push(message);
      return { messageId: "sent-" + sent.length };
    },
  };
  return { transport, sent };
}

function baseRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rule-1",
    name: "Test rule",
    enabled: true,
    conditions: [],
    conditionMode: "all",
    actions: [],
    ...overrides,
  };
}

describe("evaluateRules — condition evaluation", () => {
  it("matches 'contains' case-insensitively on subject", async () => {
    const email = makeEmail({ metadata: { subject: "URGENT: Invoice Due" } as NormalizedEmail["metadata"] });
    const { transport } = makeTransport();
    const rule = baseRule({ conditions: [{ type: "subject", op: "contains", value: "invoice" }] });

    const results = await evaluateRules(email, [rule], transport);
    expect(results[0]).toEqual({ ruleId: "rule-1", matched: true, actions: [] });
  });

  it("matches 'equals' case-insensitively on from email", async () => {
    const email = makeEmail({
      metadata: { from: { name: "Bob", email: "Bob@Example.com" } } as NormalizedEmail["metadata"],
    });
    const { transport } = makeTransport();
    const rule = baseRule({ conditions: [{ type: "from", op: "equals", value: "bob@example.com" }] });

    const results = await evaluateRules(email, [rule], transport);
    expect(results[0].matched).toBe(true);
  });

  it("matches 'matches' as a regular expression against the body", async () => {
    const email = makeEmail({ content: { clean: "Order #12345 shipped" } as NormalizedEmail["content"] });
    const { transport } = makeTransport();
    const rule = baseRule({ conditions: [{ type: "body", op: "matches", value: "Order #\\d+" }] });

    const results = await evaluateRules(email, [rule], transport);
    expect(results[0].matched).toBe(true);
  });

  it("evaluates sizeBytes as the sum of attachment sizes with NumberOp", async () => {
    const email = makeEmail({
      attachments: [
        { id: "a1", filename: "a", contentType: "text/plain", size: 1000, cid: null, content: async () => new Uint8Array() },
        { id: "a2", filename: "b", contentType: "text/plain", size: 2000, cid: null, content: async () => new Uint8Array() },
      ],
    });
    const { transport } = makeTransport();

    const gtRule = baseRule({ id: "gt", conditions: [{ type: "sizeBytes", op: "gt", value: 2500 }] });
    const ltRule = baseRule({ id: "lt", conditions: [{ type: "sizeBytes", op: "lt", value: 2500 }] });
    const eqRule = baseRule({ id: "eq", conditions: [{ type: "sizeBytes", op: "eq", value: 3000 }] });

    const results = await evaluateRules(email, [gtRule, ltRule, eqRule], transport);
    expect(results.find((r) => r.ruleId === "gt")?.matched).toBe(true);
    expect(results.find((r) => r.ruleId === "lt")?.matched).toBe(false);
    expect(results.find((r) => r.ruleId === "eq")?.matched).toBe(true);
  });

  it("evaluates hasAttachment and isReply as boolean conditions", async () => {
    const withAttachment = makeEmail({
      attachments: [
        { id: "a1", filename: "a", contentType: "text/plain", size: 10, cid: null, content: async () => new Uint8Array() },
      ],
      thread: { position: null, inReplyTo: "parent@example.com", references: [] },
    });
    const { transport } = makeTransport();

    const attachmentRule = baseRule({ id: "att", conditions: [{ type: "hasAttachment", value: true }] });
    const replyRule = baseRule({ id: "reply", conditions: [{ type: "isReply", value: true }] });

    const results = await evaluateRules(withAttachment, [attachmentRule, replyRule], transport);
    expect(results.find((r) => r.ruleId === "att")?.matched).toBe(true);
    expect(results.find((r) => r.ruleId === "reply")?.matched).toBe(true);

    const plain = makeEmail();
    const results2 = await evaluateRules(plain, [attachmentRule, replyRule], transport);
    expect(results2.find((r) => r.ruleId === "att")?.matched).toBe(false);
    expect(results2.find((r) => r.ruleId === "reply")?.matched).toBe(false);
  });

  it("conditionMode 'all' requires every condition; 'any' requires just one", async () => {
    const email = makeEmail({ metadata: { subject: "Invoice", from: { name: null, email: "x@example.com" } } as NormalizedEmail["metadata"] });
    const { transport } = makeTransport();

    const allRule = baseRule({
      id: "all",
      conditionMode: "all",
      conditions: [
        { type: "subject", op: "contains", value: "invoice" },
        { type: "from", op: "contains", value: "nomatch" },
      ],
    });
    const anyRule = baseRule({
      id: "any",
      conditionMode: "any",
      conditions: [
        { type: "subject", op: "contains", value: "invoice" },
        { type: "from", op: "contains", value: "nomatch" },
      ],
    });

    const results = await evaluateRules(email, [allRule, anyRule], transport);
    expect(results.find((r) => r.ruleId === "all")?.matched).toBe(false);
    expect(results.find((r) => r.ruleId === "any")?.matched).toBe(true);
  });
});

describe("evaluateRules — ordering and control flow", () => {
  it("sorts rules by order ascending before evaluating", async () => {
    const email = makeEmail();
    const { transport } = makeTransport();
    const evaluated: string[] = [];

    const rules: Rule[] = [
      { ...baseRule({ id: "second", order: 5 }), conditions: [] },
      { ...baseRule({ id: "first", order: 1 }), conditions: [] },
      { ...baseRule({ id: "third" }), conditions: [] }, // no order -> default 0, runs before order:1
    ];

    const results = await evaluateRules(email, rules, transport);
    evaluated.push(...results.map((r) => r.ruleId));
    expect(evaluated).toEqual(["third", "first", "second"]);
  });

  it("skips disabled rules", async () => {
    const email = makeEmail();
    const { transport } = makeTransport();
    const rules: Rule[] = [baseRule({ id: "disabled", enabled: false })];

    const results = await evaluateRules(email, rules, transport);
    expect(results).toEqual([]);
  });

  it("stopProcessing halts evaluation of subsequent rules", async () => {
    const email = makeEmail();
    const { transport } = makeTransport();
    const rules: Rule[] = [
      baseRule({ id: "stopper", order: 0, conditions: [], actions: [{ type: "stopProcessing" }] }),
      baseRule({ id: "never-runs", order: 1, conditions: [] }),
    ];

    const results = await evaluateRules(email, rules, transport);
    expect(results.map((r) => r.ruleId)).toEqual(["stopper"]);
  });

  it("stopOnFirst stops after the first matching rule, even without stopProcessing", async () => {
    const email = makeEmail({ metadata: { subject: "Invoice" } as NormalizedEmail["metadata"] });
    const { transport } = makeTransport();
    const rules: Rule[] = [
      baseRule({ id: "no-match", order: 0, conditions: [{ type: "subject", op: "contains", value: "nope" }] }),
      baseRule({ id: "matches", order: 1, conditions: [{ type: "subject", op: "contains", value: "invoice" }] }),
      baseRule({ id: "never-runs", order: 2, conditions: [] }),
    ];

    const results = await evaluateRules(email, rules, transport, { stopOnFirst: true });
    expect(results.map((r) => r.ruleId)).toEqual(["no-match", "matches"]);
  });
});

describe("evaluateRules — action execution", () => {
  it("forward sends via transport with correct threading headers", async () => {
    const email = makeEmail({
      messageId: "msg-42@example.com",
      thread: { position: null, inReplyTo: "parent@example.com", references: ["root@example.com"] },
    });
    const { transport, sent } = makeTransport();
    const rule = baseRule({
      conditions: [],
      actions: [{ type: "forward", to: [{ name: "Carol", email: "carol@example.com" }] }],
    });

    const results = await evaluateRules(email, [rule], transport);
    expect(results[0].matched).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([{ name: "Carol", email: "carol@example.com" }]);
    expect(sent[0].from).toEqual(email.metadata.from);
    expect(sent[0].inReplyTo).toBe("msg-42@example.com");
    expect(sent[0].references).toEqual(["root@example.com", "msg-42@example.com"]);
  });

  it("autoReply sends via transport with correct threading headers and default subject", async () => {
    const email = makeEmail({
      messageId: "msg-7@example.com",
      thread: { position: null, inReplyTo: null, references: [] },
      metadata: {
        from: { name: "Ada", email: "ada@example.com" },
        to: [{ name: "Support", email: "support@example.com" }],
        subject: "Question",
      } as NormalizedEmail["metadata"],
    });
    const { transport, sent } = makeTransport();
    const rule = baseRule({
      conditions: [],
      actions: [{ type: "autoReply", body: "Thanks for reaching out!" }],
    });

    const results = await evaluateRules(email, [rule], transport);
    expect(results[0].matched).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toEqual({ name: "Support", email: "support@example.com" });
    expect(sent[0].to).toEqual([{ name: "Ada", email: "ada@example.com" }]);
    expect(sent[0].subject).toBe("Re: Question");
    expect(sent[0].text).toBe("Thanks for reaching out!");
    expect(sent[0].inReplyTo).toBe("msg-7@example.com");
    expect(sent[0].references).toEqual(["msg-7@example.com"]);
  });

  it("autoReply honors an explicit subject override", async () => {
    const email = makeEmail();
    const { transport, sent } = makeTransport();
    const rule = baseRule({
      conditions: [],
      actions: [{ type: "autoReply", body: "body", subject: "Custom subject" }],
    });

    await evaluateRules(email, [rule], transport);
    expect(sent[0].subject).toBe("Custom subject");
  });

  it("does not call the transport for non-I/O actions (they are reported, not executed)", async () => {
    const email = makeEmail();
    const { transport, sent } = makeTransport();
    const rule = baseRule({
      conditions: [],
      actions: [
        { type: "setFolder", folder: "Archive" },
        { type: "setLabel", label: "Important" },
        { type: "markRead", value: true },
      ],
    });

    const results = await evaluateRules(email, [rule], transport);
    expect(sent).toHaveLength(0);
    expect(results[0].actions).toEqual(rule.actions);
  });

  it("dryRun evaluates and reports matches but never calls the transport", async () => {
    const email = makeEmail();
    const { transport, sent } = makeTransport();
    const rule = baseRule({
      conditions: [],
      actions: [{ type: "forward", to: [{ name: "Carol", email: "carol@example.com" }] }],
    });

    const results = await evaluateRules(email, [rule], transport, { dryRun: true });
    expect(results[0].matched).toBe(true);
    expect(results[0].actions).toEqual(rule.actions);
    expect(sent).toHaveLength(0);
  });
});

describe("rule persistence (D1)", () => {
  beforeAll(async () => {
    await d1Init(env.DB);
  });

  it("round-trips a rule through saveRule/loadRules", async () => {
    const rule: Rule = {
      id: "persist-1",
      name: "Archive newsletters",
      enabled: true,
      conditions: [{ type: "subject", op: "contains", value: "newsletter" }],
      conditionMode: "all",
      actions: [{ type: "setFolder", folder: "Newsletters" }],
      order: 3,
    };

    await saveRule(env.DB, rule);
    const rules = await loadRules(env.DB);
    const loaded = rules.find((r) => r.id === "persist-1");

    expect(loaded).toEqual(rule);
  });

  it("upserts on a second saveRule call with the same id", async () => {
    const rule: Rule = {
      id: "persist-2",
      name: "Original name",
      enabled: true,
      conditions: [],
      conditionMode: "any",
      actions: [],
      order: 0,
    };
    await saveRule(env.DB, rule);

    const updated: Rule = { ...rule, name: "Updated name", order: 9 };
    await saveRule(env.DB, updated);

    const rules = await loadRules(env.DB);
    const matches = rules.filter((r) => r.id === "persist-2");
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("Updated name");
    expect(matches[0].order).toBe(9);
  });

  it("loadRules excludes disabled rules and orders by rule_order ascending", async () => {
    await saveRule(env.DB, {
      id: "persist-disabled",
      name: "Disabled rule",
      enabled: false,
      conditions: [],
      conditionMode: "all",
      actions: [],
      order: -100,
    });
    await saveRule(env.DB, {
      id: "persist-order-a",
      name: "A",
      enabled: true,
      conditions: [],
      conditionMode: "all",
      actions: [],
      order: 10,
    });
    await saveRule(env.DB, {
      id: "persist-order-b",
      name: "B",
      enabled: true,
      conditions: [],
      conditionMode: "all",
      actions: [],
      order: 1,
    });

    const rules = await loadRules(env.DB);
    expect(rules.some((r) => r.id === "persist-disabled")).toBe(false);

    const ids = rules.map((r) => r.id);
    expect(ids.indexOf("persist-order-b")).toBeLessThan(ids.indexOf("persist-order-a"));
  });

  it("deleteRule removes the row", async () => {
    await saveRule(env.DB, {
      id: "persist-delete",
      name: "To be deleted",
      enabled: true,
      conditions: [],
      conditionMode: "all",
      actions: [],
    });
    await deleteRule(env.DB, "persist-delete");

    const rules = await loadRules(env.DB);
    expect(rules.some((r) => r.id === "persist-delete")).toBe(false);
  });
});
