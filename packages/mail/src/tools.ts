import type { Address, NormalizedEmail } from "@mvrx/aecs";

/**
 * Deterministic (non-AI, offline) analysis tools for `NormalizedEmail` objects
 * (AECS-SDK-1 §7.1). These are pure keyword/regex heuristics — no network
 * calls, no LLM inference. For AI-powered analysis see `@mvrx/mail/ai-tools`.
 */

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Prefer the signature/quote-stripped body, fall back to raw text, then the LLM-optimised form. */
function getBody(email: NormalizedEmail): string {
  return email.content.clean ?? email.content.text ?? email.content.forAI ?? "";
}

const NO_REPLY_SENDER = /no-?reply|do-?not-?reply|mailer-daemon|notifications?@/i;

// ── extractAddresses ─────────────────────────────────────────────────────────

const EMAIL_ADDRESS_RE =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;

/** All unique addresses across from/to/cc/bcc headers plus any found in the body text. */
export function extractAddresses(email: NormalizedEmail): Address[] {
  const seen = new Map<string, Address>();
  const add = (addr: Address): void => {
    const key = addr.email.toLowerCase();
    if (!seen.has(key)) seen.set(key, addr);
  };

  add(email.metadata.from);
  for (const addr of email.metadata.to) add(addr);
  for (const addr of email.metadata.cc) add(addr);
  for (const addr of email.metadata.bcc) add(addr);

  const body = getBody(email);
  for (const match of body.match(EMAIL_ADDRESS_RE) ?? []) {
    add({ name: null, email: match });
  }

  return Array.from(seen.values());
}

// ── detectIntent ──────────────────────────────────────────────────────────────

export type IntentType = "question" | "request" | "confirmation" | "notification" | "other";

export interface DetectedIntent {
  type: IntentType;
  confidence: number;
}

const QUESTION_WORD_RE = /\b(who|what|when|where|why|how|could you|can you|would you|do you|are you|is it|will you)\b/i;
const CONFIRMATION_RE = /\b(confirm(?:ed|ing)?|approved|agreed|sounds good|all set)\b/i;
const NOTIFICATION_RE = /\b(unsubscribe|automated|fyi|for your information|notification|reminder:)\b/i;
const REQUEST_RE = /\b(please|kindly|need you to|requesting|would you mind)\b/i;

/** Keyword-heuristic intent classification (AECS-SDK-1 §7.1). */
export function detectIntent(email: NormalizedEmail): DetectedIntent {
  const subject = email.metadata.subject ?? "";
  const body = getBody(email);
  const combined = `${subject} ${body}`;

  const hasQuestionMark = body.includes("?");
  const hasQuestionWord = QUESTION_WORD_RE.test(combined);
  if (hasQuestionMark || hasQuestionWord) {
    return { type: "question", confidence: hasQuestionMark && hasQuestionWord ? 0.9 : 0.75 };
  }

  const isNoReplySender = NO_REPLY_SENDER.test(email.metadata.from.email);
  if (isNoReplySender || NOTIFICATION_RE.test(combined)) {
    return { type: "notification", confidence: 0.85 };
  }

  if (CONFIRMATION_RE.test(combined)) {
    return { type: "confirmation", confidence: 0.8 };
  }

  if (REQUEST_RE.test(combined)) {
    return { type: "request", confidence: 0.7 };
  }

  return { type: "other", confidence: 0.5 };
}

// ── requiresReply ─────────────────────────────────────────────────────────────

export interface ReplyRequirement {
  required: boolean;
  urgency: "high" | "normal" | "low";
}

const URGENT_RE = /\b(urgent|asap|immediately|right away|as soon as possible)\b/i;

/** Heuristic: question mark / request phrasing / not a no-reply sender (AECS-SDK-1 §7.1). */
export function requiresReply(email: NormalizedEmail): ReplyRequirement {
  const subject = email.metadata.subject ?? "";
  const combined = `${subject} ${getBody(email)}`;
  const isNoReplySender = NO_REPLY_SENDER.test(email.metadata.from.email);
  const intent = detectIntent(email);

  if (isNoReplySender || intent.type === "notification") {
    return { required: false, urgency: "low" };
  }

  const required = intent.type === "question" || intent.type === "request";
  const urgency: ReplyRequirement["urgency"] = URGENT_RE.test(combined) ? "high" : required ? "normal" : "low";

  return { required, urgency };
}

// ── extractDates ──────────────────────────────────────────────────────────────

export interface ExtractedDate {
  raw: string;
  iso: string | null;
  confidence: number;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function resolveHour(hourStr: string | undefined, minuteStr: string | undefined, ampm: string | undefined) {
  if (!hourStr) return null;
  let hour = parseInt(hourStr, 10);
  const minute = minuteStr ? parseInt(minuteStr, 10) : 0;
  const period = ampm?.toLowerCase();
  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

/** Next UTC calendar date (>= `from`) that falls on `targetDay` (0 = Sunday). */
function nextWeekday(from: Date, targetDay: number): Date {
  const result = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const diff = (targetDay - result.getUTCDay() + 7) % 7;
  result.setUTCDate(result.getUTCDate() + diff);
  return result;
}

/** Dates/times mentioned in the body (AECS-SDK-1 §7.1). */
export function extractDates(email: NormalizedEmail): ExtractedDate[] {
  const body = getBody(email);
  const results: ExtractedDate[] = [];
  const seen = new Set<string>();

  const isoDateRe = /\b(\d{4}-\d{2}-\d{2})(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/gi;
  for (const match of body.matchAll(isoDateRe)) {
    const raw = match[0].trim();
    if (seen.has(raw)) continue;
    seen.add(raw);

    const [, dateStr, hourStr, minuteStr, ampm] = match;
    const time = resolveHour(hourStr, minuteStr, ampm);
    const iso = time
      ? new Date(
          `${dateStr}T${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}:00.000Z`
        ).toISOString()
      : new Date(`${dateStr}T00:00:00.000Z`).toISOString();

    results.push({ raw, iso, confidence: time ? 0.9 : 0.7 });
  }

  const weekdayRe = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/gi;
  for (const match of body.matchAll(weekdayRe)) {
    const raw = match[0].trim();
    if (seen.has(raw)) continue;
    seen.add(raw);

    const [, weekday, hourStr, minuteStr, ampm] = match;
    const referenceMs = email.metadata.timestamp !== null ? email.metadata.timestamp * 1000 : Date.now();
    const targetDate = nextWeekday(new Date(referenceMs), WEEKDAYS.indexOf(weekday.toLowerCase()));
    const time = resolveHour(hourStr, minuteStr, ampm);

    let iso: string | null = null;
    if (time) {
      targetDate.setUTCHours(time.hour, time.minute, 0, 0);
      iso = targetDate.toISOString();
    }

    results.push({ raw, iso, confidence: time ? 0.65 : 0.4 });
  }

  return results;
}

// ── extractLinks ──────────────────────────────────────────────────────────────

export interface ExtractedLink {
  url: string;
  text: string;
  type: "link" | "unsubscribe" | "tracking";
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)]+$/;
const UNSUBSCRIBE_RE = /unsubscribe|opt-?out/i;
const TRACKING_RE = /utm_|\/track|\/click|clicktrack|sendgrid\.net|mandrillapp\.com|list-manage\.com/i;

function classifyLink(url: string): ExtractedLink["type"] {
  if (UNSUBSCRIBE_RE.test(url)) return "unsubscribe";
  if (TRACKING_RE.test(url)) return "tracking";
  return "link";
}

function findAnchorText(html: string, url: string): string | null {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchorRe = new RegExp(`<a[^>]*href=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/a>`, "i");
  const match = html.match(anchorRe);
  if (!match) return null;
  const text = match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return text || null;
}

/** Unique URLs found in the body, classified by likely purpose (AECS-SDK-1 §7.1). */
export function extractLinks(email: NormalizedEmail): ExtractedLink[] {
  const html = email.content.html ?? "";
  const source = html || getBody(email);
  const seen = new Map<string, ExtractedLink>();

  for (const match of source.match(URL_RE) ?? []) {
    const url = match.replace(TRAILING_PUNCTUATION_RE, "");
    if (seen.has(url)) continue;
    const anchorText = html ? findAnchorText(html, url) : null;
    seen.set(url, { url, text: anchorText ?? url, type: classifyLink(url) });
  }

  return Array.from(seen.values());
}

export const tools = {
  extractAddresses,
  detectIntent,
  requiresReply,
  extractDates,
  extractLinks,
};
