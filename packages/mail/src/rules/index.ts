import type { Address, NormalizedEmail } from "@mvrx/aecs";
import type { EmailTransport } from "../adapters.js";

/**
 * Declarative rules engine — see AECS-SDK-1 spec §15 (data types §15.1,
 * `evaluateRules` §15.2, storage schema §15.4).
 */

// ── Data types (verbatim from AECS-SDK-1 §15.1) ─────────────────────────────

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: Condition[];
  conditionMode: "all" | "any"; // "all" = AND, "any" = OR
  actions: Action[];
  order?: number; // lower number runs first; default: 0
}

export type StringOp = "contains" | "equals" | "startsWith" | "endsWith" | "matches";
// "matches" accepts a regular expression string

export type NumberOp = "gt" | "lt" | "gte" | "lte" | "eq";

export type Condition =
  | { type: "from"; op: StringOp; value: string }
  | { type: "to"; op: StringOp; value: string }
  | { type: "subject"; op: StringOp; value: string }
  | { type: "body"; op: StringOp; value: string }
  | { type: "hasAttachment"; value: boolean }
  | { type: "sizeBytes"; op: NumberOp; value: number }
  | { type: "isReply"; value: boolean };

export type Action =
  | { type: "setFolder"; folder: string }
  | { type: "setLabel"; label: string }
  | { type: "removeLabel"; label: string }
  | { type: "markRead"; value: boolean }
  | { type: "markStarred"; value: boolean }
  | { type: "forward"; to: Address[] }
  | { type: "autoReply"; body: string; subject?: string }
  | { type: "discard" }
  | { type: "stopProcessing" }; // subsequent rules are not evaluated

export interface EvaluateOptions {
  stopOnFirst?: boolean; // stop after the first matching rule (default: false)
  dryRun?: boolean; // evaluate conditions but do not execute actions
}

export interface RuleResult {
  ruleId: string;
  matched: boolean;
  actions: Action[]; // populated only when matched === true
}

// ── Condition evaluation ─────────────────────────────────────────────────────

function applyStringOp(op: StringOp, haystack: string, value: string): boolean {
  if (op === "matches") {
    return new RegExp(value).test(haystack);
  }
  const a = haystack.toLowerCase();
  const b = value.toLowerCase();
  switch (op) {
    case "contains":
      return a.includes(b);
    case "equals":
      return a === b;
    case "startsWith":
      return a.startsWith(b);
    case "endsWith":
      return a.endsWith(b);
  }
}

function applyNumberOp(op: NumberOp, actual: number, expected: number): boolean {
  switch (op) {
    case "gt":
      return actual > expected;
    case "lt":
      return actual < expected;
    case "gte":
      return actual >= expected;
    case "lte":
      return actual <= expected;
    case "eq":
      return actual === expected;
  }
}

/** An address condition matches if the op matches either the email or the display name. */
function matchesAddress(op: StringOp, address: Address, value: string): boolean {
  if (applyStringOp(op, address.email, value)) return true;
  if (address.name && applyStringOp(op, address.name, value)) return true;
  return false;
}

/**
 * §15.1's `sizeBytes` condition doesn't pin down what "size" means for a
 * `NormalizedEmail` — there is no single raw-message byte length on the
 * type (`content.rawFull` is intentionally not persisted inline, see
 * storage.ts), only per-attachment `size` fields. This uses the sum of
 * attachment sizes as the metric: it's the only byte-accurate figure
 * available on a `NormalizedEmail`, so rules like "sizeBytes gt 10000000"
 * read as "has attachments totalling more than 10MB".
 */
function sizeBytesOf(email: NormalizedEmail): number {
  return email.attachments.reduce((total, attachment) => total + attachment.size, 0);
}

function evaluateCondition(email: NormalizedEmail, condition: Condition): boolean {
  switch (condition.type) {
    case "from":
      return matchesAddress(condition.op, email.metadata.from, condition.value);
    case "to":
      return email.metadata.to.some((address) => matchesAddress(condition.op, address, condition.value));
    case "subject":
      return applyStringOp(condition.op, email.metadata.subject ?? "", condition.value);
    case "body":
      return applyStringOp(condition.op, email.content.clean ?? email.content.text ?? "", condition.value);
    case "hasAttachment":
      return (email.attachments.length > 0) === condition.value;
    case "sizeBytes":
      return applyNumberOp(condition.op, sizeBytesOf(email), condition.value);
    case "isReply":
      return (email.thread.inReplyTo != null) === condition.value;
  }
}

function ruleMatches(email: NormalizedEmail, rule: Rule): boolean {
  if (rule.conditions.length === 0) {
    // Vacuous truth for AND, vacuous falsity for OR (no condition to satisfy it).
    return rule.conditionMode === "all";
  }
  return rule.conditionMode === "all"
    ? rule.conditions.every((condition) => evaluateCondition(email, condition))
    : rule.conditions.some((condition) => evaluateCondition(email, condition));
}

// ── Action execution ─────────────────────────────────────────────────────────

async function executeAction(email: NormalizedEmail, action: Action, transport: EmailTransport): Promise<void> {
  const references = [...email.thread.references, email.messageId];

  switch (action.type) {
    case "forward":
      await transport.send({
        from: email.metadata.from,
        to: action.to,
        subject: email.metadata.subject ?? "",
        text: email.content.text ?? email.content.clean ?? "",
        inReplyTo: email.messageId,
        references,
      });
      return;
    case "autoReply":
      await transport.send({
        // Reply "from" the recipient the message arrived at.
        from: email.metadata.to[0] ?? email.metadata.from,
        to: [email.metadata.from],
        subject: action.subject ?? `Re: ${email.metadata.subject ?? ""}`,
        text: action.body,
        inReplyTo: email.messageId,
        references,
      });
      return;
    // setFolder/setLabel/removeLabel/markRead/markStarred/discard/stopProcessing
    // are state signals, not I/O — the caller applies them using the actions
    // reported back on the RuleResult.
    default:
      return;
  }
}

// ── evaluateRules (§15.2) ────────────────────────────────────────────────────

export async function evaluateRules(
  email: NormalizedEmail,
  rules: Rule[],
  transport: EmailTransport,
  options: EvaluateOptions = {}
): Promise<RuleResult[]> {
  const sorted = [...rules].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const results: RuleResult[] = [];

  for (const rule of sorted) {
    if (rule.enabled === false) continue;

    if (!ruleMatches(email, rule)) {
      results.push({ ruleId: rule.id, matched: false, actions: [] });
      continue;
    }

    results.push({ ruleId: rule.id, matched: true, actions: rule.actions });

    if (!options.dryRun) {
      for (const action of rule.actions) {
        await executeAction(email, action, transport);
      }
    }

    const stopsProcessing = rule.actions.some((action) => action.type === "stopProcessing");
    if (options.stopOnFirst || stopsProcessing) break;
  }

  return results;
}

// ── Rule storage (§15.4) ─────────────────────────────────────────────────────

interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  conditions: string;
  condition_mode: string;
  actions: string;
  rule_order: number;
}

/** Upserts a rule row. `conditionMode`/`order` map to `condition_mode`/`rule_order`. */
export async function saveRule(db: D1Database, rule: Rule): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mvrx_rules (id, name, enabled, conditions, condition_mode, actions, rule_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         enabled = excluded.enabled,
         conditions = excluded.conditions,
         condition_mode = excluded.condition_mode,
         actions = excluded.actions,
         rule_order = excluded.rule_order`
    )
    .bind(
      rule.id,
      rule.name,
      rule.enabled ? 1 : 0,
      JSON.stringify(rule.conditions),
      rule.conditionMode,
      JSON.stringify(rule.actions),
      rule.order ?? 0
    )
    .run();
}

/** Enabled rules, ordered by `rule_order` ascending — matches the §15.3 usage example. */
export async function loadRules(db: D1Database): Promise<Rule[]> {
  const { results } = await db
    .prepare("SELECT * FROM mvrx_rules WHERE enabled = 1 ORDER BY rule_order ASC")
    .all<RuleRow>();

  return results.map((row) => ({
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    conditions: JSON.parse(row.conditions) as Condition[],
    conditionMode: row.condition_mode as "all" | "any",
    actions: JSON.parse(row.actions) as Action[],
    order: row.rule_order,
  }));
}

export async function deleteRule(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM mvrx_rules WHERE id = ?").bind(id).run();
}
