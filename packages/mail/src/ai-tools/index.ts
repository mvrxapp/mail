import type { NormalizedEmail } from "@mvrx/aecs";
import type { AiChatProvider, AiMessage } from "../adapters.js";

/**
 * AI-powered analysis tools (AECS-SDK-1 §7.2).
 *
 * Every tool builds a prompt from `email.content.forAI` (falling back to
 * `content.clean` / `content.text` if `forAI` is null), optionally appends
 * attachment `extractedText`, calls the supplied `AiChatProvider`, and
 * returns a parsed result.
 */

/** Default model used when `options.model` is not supplied. Matches the
 * documented default for `cfProvider` (§6.2), the SDK's first-class,
 * zero-latency provider. Callers should override via `options.model` when
 * using a different provider. */
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct";

export interface AiToolOptions {
  /** Override the model used for this call. Defaults to `DEFAULT_MODEL`. */
  model?: string;
  /** Append `att.extractedText` from all attachments as additional LLM context. Default: false. */
  includeAttachments?: boolean;
}

export interface SummarizeOptions extends AiToolOptions {
  /** Target sentence count for the summary. Default: 2. */
  maxSentences?: number;
}

export interface ClassifyOptions extends AiToolOptions {
  /** Candidate categories to classify into. */
  categories?: string[];
}

export interface ClassifyResult {
  category: string;
  confidence: number;
}

export interface ExtractActionResult {
  action: string;
  params: Record<string, unknown>;
}

export interface SentimentResult {
  sentiment: "positive" | "neutral" | "negative";
  confidence: number;
}

export interface ExtractEntitiesResult {
  people: string[];
  companies: string[];
  products: string[];
  amounts: string[];
}

export interface AskOptions extends AiToolOptions {
  /** The question to answer about the email (and its attachments). */
  question: string;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function baseText(email: NormalizedEmail): string {
  return email.content.forAI ?? email.content.clean ?? email.content.text ?? "";
}

function buildContext(email: NormalizedEmail, options?: AiToolOptions): string {
  let context = baseText(email);

  if (options?.includeAttachments) {
    const attachmentTexts = (email.attachments ?? [])
      .filter((att) => !!att.extractedText)
      .map((att) => `--- Attachment: ${att.filename} ---\n${att.extractedText}`);

    if (attachmentTexts.length > 0) {
      context = `${context}\n\n${attachmentTexts.join("\n\n")}`.trim();
    }
  }

  return context;
}

function resolveModel(options?: AiToolOptions): string {
  return options?.model ?? DEFAULT_MODEL;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

async function run(
  provider: AiChatProvider,
  options: AiToolOptions | undefined,
  messages: AiMessage[]
): Promise<string> {
  const { text } = await provider.run(resolveModel(options), messages);
  return text;
}

// ── Tools ────────────────────────────────────────────────────────────────────

/** Summarise the email in `options.maxSentences` sentences (default: 2). */
export async function summarize(
  email: NormalizedEmail,
  provider: AiChatProvider,
  options?: SummarizeOptions
): Promise<string> {
  const maxSentences = options?.maxSentences ?? 2;
  const messages: AiMessage[] = [
    {
      role: "system",
      content: `You are an email summarization assistant. Summarize the email below in at most ${maxSentences} sentence(s). Respond with only the summary text, no preamble or labels.`,
    },
    { role: "user", content: buildContext(email, options) },
  ];
  const text = await run(provider, options, messages);
  return text.trim();
}

/** Classify the email into one of `options.categories`. */
export async function classify(
  email: NormalizedEmail,
  provider: AiChatProvider,
  options?: ClassifyOptions
): Promise<ClassifyResult> {
  const categories = options?.categories;
  const instruction = categories?.length
    ? `Classify the email below into exactly one of these categories: ${categories.join(", ")}.`
    : "Classify the email below into an appropriate short category label.";

  const messages: AiMessage[] = [
    {
      role: "system",
      content: `${instruction} Respond with ONLY strict JSON matching this shape, no other text: {"category": string, "confidence": number between 0 and 1}.`,
    },
    { role: "user", content: buildContext(email, options) },
  ];
  const text = await run(provider, options, messages);
  return parseJson<ClassifyResult>(text, { category: categories?.[0] ?? "other", confidence: 0 });
}

/** Extract the primary actionable item (task, meeting, request, etc.) from the email. */
export async function extractAction(
  email: NormalizedEmail,
  provider: AiChatProvider,
  options?: AiToolOptions
): Promise<ExtractActionResult> {
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        'Extract the primary actionable item from the email below. Respond with ONLY strict JSON matching this shape, no other text: {"action": string (a snake_case action identifier, e.g. "schedule_meeting"), "params": object (relevant parameters such as date, time, participants)}. If there is no clear action, respond with {"action": "none", "params": {}}.',
    },
    { role: "user", content: buildContext(email, options) },
  ];
  const text = await run(provider, options, messages);
  return parseJson<ExtractActionResult>(text, { action: "none", params: {} });
}

/** Detect the overall sentiment of the email. */
export async function sentiment(
  email: NormalizedEmail,
  provider: AiChatProvider,
  options?: AiToolOptions
): Promise<SentimentResult> {
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        'Analyze the sentiment of the email below. Respond with ONLY strict JSON matching this shape, no other text: {"sentiment": "positive" | "neutral" | "negative", "confidence": number between 0 and 1}.',
    },
    { role: "user", content: buildContext(email, options) },
  ];
  const text = await run(provider, options, messages);
  return parseJson<SentimentResult>(text, { sentiment: "neutral", confidence: 0 });
}

/** Extract key entities (people, companies, products, amounts) from the email. */
export async function extractEntities(
  email: NormalizedEmail,
  provider: AiChatProvider,
  options?: AiToolOptions
): Promise<ExtractEntitiesResult> {
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        'Extract key entities from the email below. Respond with ONLY strict JSON matching this shape, no other text: {"people": string[], "companies": string[], "products": string[], "amounts": string[]}. Use an empty array for any category with no matches.',
    },
    { role: "user", content: buildContext(email, options) },
  ];
  const text = await run(provider, options, messages);
  return parseJson<ExtractEntitiesResult>(text, {
    people: [],
    companies: [],
    products: [],
    amounts: [],
  });
}

/** Answer a free-form question about the email (and its attachments). */
export async function ask(
  email: NormalizedEmail,
  provider: AiChatProvider,
  options: AskOptions
): Promise<string> {
  const messages: AiMessage[] = [
    {
      role: "system",
      content:
        "Answer the question below using only information contained in the email context provided. If the answer cannot be found, say so plainly. Respond with a concise natural-language answer, not JSON.",
    },
    {
      role: "user",
      content: `${buildContext(email, options)}\n\nQuestion: ${options.question}`,
    },
  ];
  const text = await run(provider, options, messages);
  return text.trim();
}

export const aiTools = {
  summarize,
  classify,
  extractAction,
  sentiment,
  extractEntities,
  ask,
};
