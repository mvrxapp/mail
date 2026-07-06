import type { Address, EmailThread, NormalizedEmail } from "@mvrx/aecs";
import type { AiChatProvider, AiMessage, EmailTransport, OutboundEmail } from "../adapters.js";

/**
 * AI Compose — writing surfaces for drafting, replying to, and improving email
 * content. Roadmap module per AECS-SDK-1 §8 (AI Compose — Writing Surfaces) and
 * §12.3 (`ComposeOptions`).
 */

// ── Shared option types (§12.3 `ComposeOptions`) ─────────────────────────────

export type Tone = "professional" | "friendly" | "formal" | "casual" | "empathetic" | "assertive";
export type Length = "concise" | "standard" | "detailed";

export interface ComposeOptions {
  /** Override the provider's default model. */
  model?: string;
  /** Writing tone. Default: "professional". */
  tone?: Tone;
  /** Response length target. Default: "standard". */
  length?: Length;
  /** Output format. Default: "text". */
  format?: "text" | "html";
  /** ISO 639-1 target language. Defaults to the detected input language. */
  language?: string;
  /** Prepended to the SDK's default system instructions. */
  systemPrompt?: string;
  /** Cap LLM response length (best-effort; not all providers enforce this). Default: 1024. */
  maxTokens?: number;
  /** Pass `att.extractedText` from all attachments as additional LLM context. Default: false. */
  includeAttachments?: boolean;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, professional email writing assistant. Respond with only the requested " +
  "content and nothing else — no preamble, no explanation, no surrounding quotes or markdown code fences.";

const DEFAULT_MAX_TOKENS = 1024;

function lengthDescription(length: Length): string {
  switch (length) {
    case "concise":
      return "concise and brief";
    case "detailed":
      return "detailed and thorough";
    default:
      return "standard length";
  }
}

function formatAddress(address: Address): string {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

/** Builds the system message shared by every compose call, layering in `ComposeOptions`. */
function systemMessage(options: ComposeOptions | undefined, instruction: string): AiMessage {
  const parts = [DEFAULT_SYSTEM_PROMPT, instruction];
  if (options?.tone) parts.push(`Tone: ${options.tone}.`);
  if (options?.length) parts.push(`Length: ${lengthDescription(options.length)}.`);
  if (options?.format) {
    parts.push(`Output format: ${options.format === "html" ? "HTML" : "plain text"}.`);
  }
  if (options?.language) parts.push(`Write in the language with ISO 639-1 code "${options.language}".`);
  parts.push(`Keep the response under approximately ${options?.maxTokens ?? DEFAULT_MAX_TOKENS} tokens.`);
  if (options?.systemPrompt) parts.push(options.systemPrompt);
  return { role: "system", content: parts.join("\n") };
}

/** `ComposeOptions.model` overrides the provider's own default; an empty string
 * signals "use the provider's default model" for providers that key off a
 * default (see AECS-SDK-1 §6). */
function resolveModel(options?: ComposeOptions): string {
  return options?.model ?? "";
}

async function run(provider: AiChatProvider, messages: AiMessage[], options?: ComposeOptions): Promise<string> {
  const { text } = await provider.run(resolveModel(options), messages);
  return text.trim();
}

/** Renders a `NormalizedEmail` as LLM context, optionally including attachment text. */
function emailContext(email: NormalizedEmail, includeAttachments?: boolean): string {
  const body = email.content.forAI ?? email.content.clean ?? email.content.text ?? "";
  const lines = [
    `From: ${formatAddress(email.metadata.from)}`,
    `Subject: ${email.metadata.subject ?? "(no subject)"}`,
    "",
    body,
  ];
  if (includeAttachments) {
    const attachmentTexts = email.attachments
      .filter((attachment) => attachment.extractedText)
      .map((attachment) => `--- Attachment: ${attachment.filename} ---\n${attachment.extractedText}`);
    if (attachmentTexts.length > 0) {
      lines.push("", ...attachmentTexts);
    }
  }
  return lines.join("\n");
}

// ── 8.1 Draft from scratch ───────────────────────────────────────────────────

export interface DraftOptions extends ComposeOptions {
  /** Sender identity, included as context for the draft. Not part of §12.3
   * `ComposeOptions`, but shown in the §8.1 example. */
  from?: Address;
}

export interface DraftResult {
  subject: string;
  body: string;
}

function parseSubjectAndBody(text: string): DraftResult {
  const match = text.match(/^subject:\s*(.+?)\r?\n+([\s\S]*)$/i);
  if (match) {
    return { subject: match[1].trim(), body: match[2].trim() };
  }
  return { subject: "", body: text.trim() };
}

/** §8.1 — generate a new email from a prompt or structured input. */
export async function draft(prompt: string, provider: AiChatProvider, options?: DraftOptions): Promise<DraftResult> {
  const messages: AiMessage[] = [
    systemMessage(
      options,
      'Draft a new email from the user\'s instructions. Respond with exactly two parts: a first line ' +
        'formatted as "Subject: <subject line>", followed by a blank line and then the email body.'
    ),
    {
      role: "user",
      content: options?.from ? `${prompt}\n\n(Sender: ${formatAddress(options.from)})` : prompt,
    },
  ];
  const text = await run(provider, messages, options);
  return parseSubjectAndBody(text);
}

// ── 8.2 Reply assistance ─────────────────────────────────────────────────────

export interface ReplyOptions extends ComposeOptions {
  /** What the reply should accomplish. */
  intent: string;
}

export interface ReplyResult {
  body: string;
}

/** §8.2 — generate a reply to a single email. */
export async function reply(email: NormalizedEmail, provider: AiChatProvider, options: ReplyOptions): Promise<ReplyResult> {
  const messages: AiMessage[] = [
    systemMessage(options, "Write a reply to the email the user provides. Respond with only the reply body text."),
    {
      role: "user",
      content: [
        "Original email:",
        emailContext(email, options.includeAttachments),
        "",
        `Reply intent: ${options.intent}`,
      ].join("\n"),
    },
  ];
  const body = await run(provider, messages, options);
  return { body };
}

export interface ReplyToThreadOptions extends ReplyOptions {
  /** Whether the reply should open with a greeting. Not part of §12.3
   * `ComposeOptions`, but shown in the §8.2 example. */
  includeGreeting?: boolean;
}

/** §8.2 — generate a reply in the context of a full thread. */
export async function replyToThread(
  thread: EmailThread,
  provider: AiChatProvider,
  options: ReplyToThreadOptions
): Promise<ReplyResult> {
  const greetingInstruction = options.includeGreeting ? " Begin with an appropriate greeting." : "";
  const messages: AiMessage[] = [
    systemMessage(
      options,
      "Write a reply in the context of the full email thread the user provides. Respond with only the " +
        "reply body text." +
        greetingInstruction
    ),
    {
      role: "user",
      content: ["Thread:", thread.forAI(), "", `Reply intent: ${options.intent}`].join("\n"),
    },
  ];
  const body = await run(provider, messages, options);
  return { body };
}

// ── 8.3 Improve existing copy ────────────────────────────────────────────────

/** §8.3 — general improvement: clarity, grammar, flow. */
export async function improve(text: string, provider: AiChatProvider, options?: ComposeOptions): Promise<string> {
  const messages: AiMessage[] = [
    systemMessage(
      options,
      "Improve the clarity, grammar, and flow of the email text the user provides. Respond with only " +
        "the improved text."
    ),
    { role: "user", content: text },
  ];
  return run(provider, messages, options);
}

export interface ToneOptions extends ComposeOptions {
  tone: Tone;
}

/** §8.3 — adjust the tone of existing text. */
export async function tone(text: string, provider: AiChatProvider, options: ToneOptions): Promise<string> {
  const messages: AiMessage[] = [
    systemMessage(
      options,
      `Rewrite the email text the user provides in a ${options.tone} tone, preserving its meaning. ` +
        "Respond with only the rewritten text."
    ),
    { role: "user", content: text },
  ];
  return run(provider, messages, options);
}

// ── 8.4 Shorten or expand ────────────────────────────────────────────────────

export interface ShortenOptions extends ComposeOptions {
  /** Approximate word count target. Not part of §12.3 `ComposeOptions`, but
   * shown in the §8.4 example. */
  targetWords?: number;
}

/** §8.4 — shorten text, preserving meaning. */
export async function shorten(text: string, provider: AiChatProvider, options?: ShortenOptions): Promise<string> {
  const targetInstruction = options?.targetWords ? ` Target approximately ${options.targetWords} words.` : "";
  const messages: AiMessage[] = [
    systemMessage(
      options,
      "Shorten the email text the user provides, preserving its meaning." +
        targetInstruction +
        " Respond with only the shortened text."
    ),
    { role: "user", content: text },
  ];
  return run(provider, messages, options);
}

export interface ExpandOptions extends ComposeOptions {
  /** Additional context to weave into the expanded text. Not part of §12.3
   * `ComposeOptions`, but shown in the §8.4 example. */
  addContext?: string;
}

/** §8.4 — expand text, adding detail, context, and politeness. */
export async function expand(text: string, provider: AiChatProvider, options?: ExpandOptions): Promise<string> {
  const contextInstruction = options?.addContext ? ` Additional context: ${options.addContext}` : "";
  const messages: AiMessage[] = [
    systemMessage(
      options,
      "Expand the email text the user provides, adding detail, context, and politeness." +
        contextInstruction +
        " Respond with only the expanded text."
    ),
    { role: "user", content: text },
  ];
  return run(provider, messages, options);
}

// ── 8.5 Subject line generation ──────────────────────────────────────────────

export interface SuggestSubjectsOptions extends ComposeOptions {
  /** Number of subject lines to generate. Not part of §12.3 `ComposeOptions`,
   * but shown in the §8.5 example. Default: 3. */
  count?: number;
}

function parseSubjectLines(text: string, count: number): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((line) => String(line).trim())
          .filter(Boolean)
          .slice(0, count);
      }
    } catch {
      // Not valid JSON — fall through to line-based parsing.
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, count);
}

/** §8.5 — generate candidate subject lines for a body of text. */
export async function suggestSubjects(
  body: string,
  provider: AiChatProvider,
  options?: SuggestSubjectsOptions
): Promise<string[]> {
  const count = options?.count ?? 3;
  const messages: AiMessage[] = [
    systemMessage(
      options,
      `Suggest ${count} distinct subject lines for the email body the user provides. Respond with ` +
        `exactly ${count} subject lines, one per line, with no numbering, bullets, or extra commentary.`
    ),
    { role: "user", content: body },
  ];
  const text = await run(provider, messages, options);
  return parseSubjectLines(text, count);
}

// ── 8.6 Translation ──────────────────────────────────────────────────────────

export interface TranslateOptions extends ComposeOptions {
  /** ISO 639-1 target language. The §8.6 example uses `targetLanguage` rather
   * than the generic §12.3 `language` field, so both are supported: */
  targetLanguage: string;
  /** Preserve line breaks and paragraph structure. Not part of §12.3
   * `ComposeOptions`, but shown in the §8.6 example. */
  preserveFormatting?: boolean;
}

/** §8.6 — translate text into a target language. */
export async function translate(text: string, provider: AiChatProvider, options: TranslateOptions): Promise<string> {
  const formattingInstruction = options.preserveFormatting
    ? " Preserve the original formatting, including line breaks and paragraph structure."
    : "";
  const messages: AiMessage[] = [
    systemMessage(
      options,
      `Translate the email text the user provides into the language with ISO 639-1 code ` +
        `"${options.targetLanguage}".` +
        formattingInstruction +
        " Respond with only the translated text."
    ),
    { role: "user", content: text },
  ];
  return run(provider, messages, options);
}

// ── 8.8 Send composed email ──────────────────────────────────────────────────

/** Envelope fields for `send()` — everything `OutboundEmail` needs except the
 * body, which is supplied separately as composed text (§8.8). */
export type SendEnvelope = Omit<OutboundEmail, "text" | "html">;

/** §8.8 — send composed text through an `EmailTransport`, building the
 * `OutboundEmail` from the envelope and body. `format` selects whether `body`
 * is placed on `text` or `html` (default: "text"). */
export async function send(
  envelope: SendEnvelope,
  body: string,
  transport: EmailTransport,
  format: "text" | "html" = "text"
): Promise<{ messageId: string }> {
  const message: OutboundEmail = format === "html" ? { ...envelope, html: body } : { ...envelope, text: body };
  return transport.send(message);
}

// ── 14.2 Custom compose strategy ─────────────────────────────────────────────

export interface ComposeDefaults {
  /** Used when a compose call omits its `provider` argument. */
  provider?: AiChatProvider;
  /** Prepended to every compose call's system instructions, ahead of any
   * per-call `systemPrompt`. */
  systemPrompt?: string;
  defaultTone?: Tone;
  defaultLength?: Length;
  model?: string;
  format?: "text" | "html";
  language?: string;
  maxTokens?: number;
}

function withDefaults<T extends ComposeOptions>(defaults: ComposeDefaults, options?: T): T {
  const base = options ?? ({} as T);
  return {
    ...base,
    model: base.model ?? defaults.model,
    tone: base.tone ?? defaults.defaultTone,
    length: base.length ?? defaults.defaultLength,
    format: base.format ?? defaults.format,
    language: base.language ?? defaults.language,
    maxTokens: base.maxTokens ?? defaults.maxTokens,
    systemPrompt: [defaults.systemPrompt, base.systemPrompt].filter(Boolean).join("\n\n") || undefined,
  } as T;
}

/** §14.2 — build a `compose`-shaped object with default options (and
 * optionally a default provider) baked in. Per-call arguments still win over
 * defaults. */
export function createCompose(defaults: ComposeDefaults = {}) {
  function resolveProvider(provider?: AiChatProvider): AiChatProvider {
    const resolved = provider ?? defaults.provider;
    if (!resolved) {
      throw new Error("createCompose: no AiChatProvider was passed and no default provider is configured");
    }
    return resolved;
  }

  return {
    draft: (prompt: string, provider?: AiChatProvider, options?: DraftOptions) =>
      draft(prompt, resolveProvider(provider), withDefaults(defaults, options)),
    reply: (email: NormalizedEmail, provider?: AiChatProvider, options?: ReplyOptions) =>
      reply(email, resolveProvider(provider), withDefaults(defaults, options ?? ({ intent: "" } as ReplyOptions))),
    replyToThread: (thread: EmailThread, provider?: AiChatProvider, options?: ReplyToThreadOptions) =>
      replyToThread(
        thread,
        resolveProvider(provider),
        withDefaults(defaults, options ?? ({ intent: "" } as ReplyToThreadOptions))
      ),
    improve: (text: string, provider?: AiChatProvider, options?: ComposeOptions) =>
      improve(text, resolveProvider(provider), withDefaults(defaults, options)),
    tone: (text: string, provider?: AiChatProvider, options?: ToneOptions) =>
      tone(text, resolveProvider(provider), withDefaults(defaults, options ?? ({ tone: "professional" } as ToneOptions))),
    shorten: (text: string, provider?: AiChatProvider, options?: ShortenOptions) =>
      shorten(text, resolveProvider(provider), withDefaults(defaults, options)),
    expand: (text: string, provider?: AiChatProvider, options?: ExpandOptions) =>
      expand(text, resolveProvider(provider), withDefaults(defaults, options)),
    suggestSubjects: (body: string, provider?: AiChatProvider, options?: SuggestSubjectsOptions) =>
      suggestSubjects(body, resolveProvider(provider), withDefaults(defaults, options)),
    translate: (text: string, provider?: AiChatProvider, options?: TranslateOptions) =>
      translate(
        text,
        resolveProvider(provider),
        withDefaults(defaults, options ?? ({ targetLanguage: "en" } as TranslateOptions))
      ),
    send,
  };
}

// ── Appendix A namespace ─────────────────────────────────────────────────────

export const compose = {
  draft,
  reply,
  replyToThread,
  improve,
  tone,
  shorten,
  expand,
  suggestSubjects,
  translate,
  send,
};
