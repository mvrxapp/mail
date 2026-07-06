import type { Attachment, AttachmentHandler, ForAIWrapper, NormalizedEmail } from "@mvrx/aecs";
import { wrappers } from "@mvrx/aecs/wrappers";
import type { BlobPutOptions, BlobStore } from "../adapters.js";
import { r2BlobStore } from "../transports/index.js";

/**
 * Attachment processing pipeline (AECS-SDK-1 §9.3–9.6).
 *
 * The spec marks §9.3–9.8 "Status: Roadmap" — this module is that pipeline's
 * implementation: a composable `AttachmentProcessor`/`AttachmentHandler`
 * chain (store to R2, extract PDF text, OCR images, transcribe audio) plus
 * `attachmentsForAI`, which aggregates whatever `att.extractedText` the
 * chain populated into a single LLM-ready string.
 *
 * DECISION: `ocr`, `transcribe`, `cfPdfExtractor`, `runOcr`, and
 * `runTranscribe` all take the raw Cloudflare `Ai` binding rather than the
 * SDK's `AiChatProvider` (see `../adapters.js` / `cfProvider` in
 * `../providers/index.js`). `AiChatProvider.run(model, messages)` is a
 * text-only chat interface — there is no way to attach image or audio bytes
 * to an `AiMessage`. Vision/audio inference on Workers AI requires calling
 * `Ai.run(model, inputs)` directly with model-specific input shapes (e.g.
 * `{ image: number[] }`, `{ audio: number[] }`), so these processors bypass
 * `AiChatProvider` entirely and depend on `Ai` instead.
 */

// ── AttachmentProcessor (§9.5) ───────────────────────────────────────────────

/**
 * Object-form processor: `accepts` gates whether `process` runs for a given
 * attachment. Compose one or more into a single `AttachmentHandler` with
 * `processors.chain(...)`.
 */
export interface AttachmentProcessor {
  accepts(att: Attachment): boolean;
  process(att: Attachment): Promise<void> | void;
}

function isAttachmentProcessor(
  proc: AttachmentProcessor | AttachmentHandler
): proc is AttachmentProcessor {
  return typeof proc !== "function";
}

// ── processors.chain (§9.4) ──────────────────────────────────────────────────

/**
 * Composes any mix of `AttachmentProcessor` objects and bare
 * `AttachmentHandler` functions into a single `AttachmentHandler`, run in
 * order against `parse()`'s `onAttachment` option. Processor objects only
 * run when `accepts(att)` returns true; handler functions always run.
 */
export function chain(...procs: (AttachmentProcessor | AttachmentHandler)[]): AttachmentHandler {
  return async (att, ctx) => {
    for (const proc of procs) {
      if (isAttachmentProcessor(proc)) {
        if (proc.accepts(att)) await proc.process(att);
      } else {
        await proc(att, ctx);
      }
    }
  };
}

// ── processors.storeToR2 (§9.3) ──────────────────────────────────────────────

export interface StoreToR2Options {
  /** Prefix for the stored key, before `<messageId>/<filename>`. Default: "att". */
  keyPrefix?: string;
  /** Derive a public/signed URL for the stored key. See NOTE below. */
  publicUrl?: (key: string) => string;
}

/**
 * Stores `att.content()` bytes to a `BlobStore` (or a raw Cloudflare
 * `R2Bucket`, which is wrapped via `r2BlobStore()`), keyed
 * `${keyPrefix}/<messageId>/<filename>`, and records that key on
 * `att.blobKey`.
 *
 * NOTE: §9.3 of the spec shows `publicUrl` populating an `att.url` field,
 * but the `Attachment` type (`@mvrx/aecs`) has no `url` property — only
 * `blobKey`. `publicUrl`, when supplied, is still invoked and forwarded to
 * `BlobStore.put` as `BlobPutOptions.publicUrl` (for stores that record it),
 * but there is nowhere on `Attachment` to persist the resulting URL, so only
 * `att.blobKey` is set here.
 */
export function storeToR2(store: BlobStore | R2Bucket, options?: StoreToR2Options): AttachmentHandler {
  const blobStore: BlobStore = isRawR2Bucket(store) ? r2BlobStore(store) : store;
  const keyPrefix = options?.keyPrefix ?? "att";

  return async (att, ctx) => {
    const key = `${keyPrefix}/${ctx.messageId}/${att.filename}`;
    const bytes = await att.content();

    const putOptions: BlobPutOptions = { contentType: att.contentType };
    if (options?.publicUrl) putOptions.publicUrl = options.publicUrl(key);

    await blobStore.put(key, bytes, putOptions);
    att.blobKey = key;
  };
}

/** `R2Bucket.head()` has no equivalent on `BlobStore`, so its presence
 * distinguishes a raw R2 binding from an already-wrapped `BlobStore`. */
function isRawR2Bucket(store: BlobStore | R2Bucket): store is R2Bucket {
  return typeof (store as R2Bucket).head === "function";
}

// ── processors.pdfToText (§9.4) ──────────────────────────────────────────────

export interface PdfToTextOptions {
  /** Extracts text from PDF bytes. Use `processors.cfPdfExtractor(env.AI)` or a custom extractor. */
  extractor: (bytes: Uint8Array) => Promise<string | null>;
}

/** Sets `att.extractedText` for `application/pdf` attachments via the supplied extractor. */
export function pdfToText(options: PdfToTextOptions): AttachmentHandler {
  return async (att) => {
    if (att.contentType !== "application/pdf") return;
    att.extractedText = await options.extractor(await att.content());
  };
}

// ── processors.cfPdfExtractor (§9.4) ─────────────────────────────────────────

/**
 * PDF-to-text extractor backed by Cloudflare Workers AI document conversion
 * (`Ai.toMarkdown`, which accepts `{ name, blob }` documents and returns
 * `{ format: "markdown", data }` — or `{ format: "error", error }` — per
 * attachment). Returns the converted markdown, or `null` on conversion
 * failure.
 */
export function cfPdfExtractor(ai: Ai): (bytes: Uint8Array) => Promise<string | null> {
  return async (bytes: Uint8Array): Promise<string | null> => {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const [result] = await ai.toMarkdown([{ name: "document.pdf", blob }]);
    if (!result || result.format !== "markdown") return null;
    return result.data;
  };
}

// ── processors.ocr (§9.4) ────────────────────────────────────────────────────

const DEFAULT_OCR_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const DEFAULT_OCR_PROMPT = "Extract all text visible in this image.";

export interface OcrOptions {
  ai: Ai;
  /** Vision model to run. Default: "@cf/llava-hf/llava-1.5-7b-hf". */
  model?: string;
  /** Instruction passed to the vision model. Default: "Extract all text visible in this image." */
  prompt?: string;
}

/** Sets `att.extractedText` for `image/*` attachments via Workers AI OCR (see `runOcr`). */
export function ocr(options: OcrOptions): AttachmentHandler {
  return async (att) => {
    if (!att.contentType.startsWith("image/")) return;
    att.extractedText = await runOcr(options.ai, await att.content(), {
      model: options.model,
      prompt: options.prompt,
    });
  };
}

/**
 * Runs OCR on raw image bytes directly against the `Ai` binding (real
 * Workers AI vision inference — not verified by these offline tests; see
 * test/attachments.test.ts). Uses `ai.run(model, inputs)` rather than
 * `AiChatProvider`, since chat providers are text-only (see file-level
 * DECISION comment above).
 *
 * `model`/`prompt` default to the same values as `ocr()`'s options so this
 * can also be called directly (e.g. from a Queue consumer doing async
 * extraction, §9.8) with just `(ai, bytes)`.
 */
export async function runOcr(
  ai: Ai,
  bytes: Uint8Array,
  options?: { model?: string; prompt?: string }
): Promise<string | null> {
  const model: string = options?.model ?? DEFAULT_OCR_MODEL;
  const prompt: string = options?.prompt ?? DEFAULT_OCR_PROMPT;
  // Workers AI vision models take raw image bytes as a plain number array.
  const input: Record<string, unknown> = { image: Array.from(bytes), prompt };
  const result = (await ai.run(model, input)) as { description?: string };
  return result.description ?? null;
}

// ── processors.transcribe (§9.4) ─────────────────────────────────────────────

const DEFAULT_TRANSCRIBE_MODEL = "@cf/openai/whisper";

export interface TranscribeOptions {
  ai: Ai;
  /** Speech-to-text model to run. Default: "@cf/openai/whisper". */
  model?: string;
  /** BCP-47 language hint (only honored by models that accept it, e.g. whisper-large-v3-turbo). */
  language?: string;
}

/** Sets `att.extractedText` for `audio/*` attachments via Workers AI transcription (see `runTranscribe`). */
export function transcribe(options: TranscribeOptions): AttachmentHandler {
  return async (att) => {
    if (!att.contentType.startsWith("audio/")) return;
    att.extractedText = await runTranscribe(options.ai, await att.content(), {
      model: options.model,
      language: options.language,
    });
  };
}

/**
 * Transcribes raw audio bytes directly against the `Ai` binding (real
 * Workers AI transcription — not verified by these offline tests; see
 * test/attachments.test.ts). Uses `ai.run(model, inputs)` rather than
 * `AiChatProvider`, for the same reason as `runOcr` (see file-level
 * DECISION comment above).
 *
 * `model`/`language` default to the same values as `transcribe()`'s options
 * so this can also be called directly with just `(ai, bytes)` (e.g. from a
 * Queue consumer, §9.8).
 */
export async function runTranscribe(
  ai: Ai,
  bytes: Uint8Array,
  options?: { model?: string; language?: string }
): Promise<string | null> {
  const model: string = options?.model ?? DEFAULT_TRANSCRIBE_MODEL;
  // Workers AI whisper models take raw audio bytes as a plain number array.
  const input: Record<string, unknown> = { audio: Array.from(bytes) };
  if (options?.language) input.language = options.language;
  const result = (await ai.run(model, input)) as { text?: string };
  return result.text ?? null;
}

// ── processors namespace ─────────────────────────────────────────────────────

export const processors = {
  chain,
  storeToR2,
  pdfToText,
  cfPdfExtractor,
  ocr,
  transcribe,
  runOcr,
  runTranscribe,
};

// ── attachmentsForAI (§9.6) ───────────────────────────────────────────────────

const DEFAULT_MAX_CHARS_PER_ATTACHMENT = 4_000;
const DEFAULT_MAX_TOTAL_CHARS = 16_000;

export interface AttachmentsForAIOptions {
  /** Max characters per attachment. Default: 4_000. */
  maxCharsPerAttachment?: number;
  /** Max total characters across all attachments. Default: 16_000. */
  maxTotalChars?: number;
  /**
   * Wrap each attachment's text block. Default: `wrappers.xml("attachment")`.
   * Set to `null` to disable wrapping.
   */
  wrapper?: ForAIWrapper | null;
  /**
   * Which content types to include. Accepts exact types or `type/*` glob
   * patterns (e.g. `["application/pdf", "image/*", "audio/*"]`).
   * Default: include all attachments that have `extractedText` set.
   */
  include?: string[];
  /** Label for each attachment block. Default: `(att) => att.filename`. */
  label?: (att: Attachment) => string;
}

function matchesContentType(pattern: string, contentType: string): boolean {
  if (pattern.endsWith("/*")) return contentType.startsWith(pattern.slice(0, -1));
  return pattern === contentType;
}

/**
 * Aggregates `att.extractedText` across `attachments` into a single
 * LLM-ready string, once processors (`processors.pdfToText`/`ocr`/
 * `transcribe`/a custom `AttachmentProcessor`) have populated it. Attachments
 * without `extractedText` are skipped. Returns `null` if no attachment
 * contributed a block.
 *
 * Self-contained: unlike the rest of this module, this does not reuse any
 * `@mvrx/aecs` aggregation logic (there is none for attachments) — it's a
 * standalone implementation of the format documented in AECS-SDK-1 §9.6.
 *
 * Each block's body is `name="<label>" type="<contentType>"` followed by the
 * (possibly truncated) extracted text; `wrapper.wrap(body, email)` then
 * wraps that body (default: `<attachment>...</attachment>` tags). Note that
 * `ForAIWrapper.wrap` only takes a plain content string — it cannot attach
 * `name`/`type` as literal XML attributes on its own opening tag, so those
 * are embedded as a text line inside the wrapped body instead. `wrapper.wrap`
 * also expects a `NormalizedEmail` second argument that this function has no
 * access to (it works on a bare `Attachment[]`, not an owning email); the
 * built-in wrappers (`xml`/`markdown`/`block`) all ignore that argument, so a
 * stub is passed. A custom `ForAIWrapper` that reads the email argument will
 * not see real data here.
 *
 * `maxTotalChars` caps the cumulative length of the joined output (including
 * wrapper tags): once adding the next wrapped block would exceed the budget,
 * that block (and any after it) is dropped rather than truncated mid-block.
 */
export function attachmentsForAI(
  attachments: Attachment[],
  options?: AttachmentsForAIOptions
): string | null {
  const maxCharsPerAttachment = options?.maxCharsPerAttachment ?? DEFAULT_MAX_CHARS_PER_ATTACHMENT;
  const maxTotalChars = options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const wrapper = options?.wrapper === undefined ? wrappers.xml("attachment") : options.wrapper;
  const include = options?.include;
  const label = options?.label ?? ((att: Attachment) => att.filename);

  const blocks: string[] = [];
  let totalChars = 0;

  for (const att of attachments) {
    if (!att.extractedText) continue;
    if (include && !include.some((pattern) => matchesContentType(pattern, att.contentType))) continue;

    const fullText = att.extractedText;
    const isTruncated = fullText.length > maxCharsPerAttachment;
    const shown = isTruncated ? fullText.slice(0, maxCharsPerAttachment) : fullText;

    let body = `name="${label(att)}" type="${att.contentType}"\n${shown}`;
    if (isTruncated) {
      body += `\n[truncated — ${maxCharsPerAttachment} chars shown of ${fullText.length}]`;
    }

    // ForAIWrapper.wrap(content, email) — see doc comment above for why a
    // stub NormalizedEmail is passed here.
    const wrapped = wrapper ? wrapper.wrap(body, undefined as unknown as NormalizedEmail) : body;

    if (totalChars > 0 && totalChars + wrapped.length > maxTotalChars) break;
    blocks.push(wrapped);
    totalChars += wrapped.length;
  }

  if (blocks.length === 0) return null;
  return blocks.join("\n\n");
}
