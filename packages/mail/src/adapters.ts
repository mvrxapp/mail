import type { Address } from "@mvrx/aecs";

/**
 * Core adapter interfaces for @mvrx/mail.
 *
 * Implement these to plug in alternative storage, transport, notification,
 * AI, and auth backends without changing any other SDK code.
 */

// ── BlobStore ────────────────────────────────────────────────────────────────

export interface BlobPutOptions {
  contentType?: string;
  /** Public-facing URL after storing, if the store supports it. */
  publicUrl?: string;
}

export interface BlobObject {
  key: string;
  size: number;
  contentType: string | null;
}

/**
 * Abstracts R2, S3, local filesystem, or any object store.
 * The CF R2 implementation ships as `r2BlobStore(bucket)` in `@mvrx/mail/transports`.
 */
export interface BlobStore {
  put(key: string, value: Uint8Array | ArrayBuffer | string, options?: BlobPutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<BlobObject[]>;
}

// ── EmailTransport ───────────────────────────────────────────────────────────

export type { Address };

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  /** Raw bytes or base64 string. */
  content: Uint8Array | string;
  /** Content-ID for inline images. */
  cid?: string;
}

export interface OutboundEmail {
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  text?: string;
  html?: string;
  /** Message-ID of the parent message (sets In-Reply-To header). */
  inReplyTo?: string;
  /** Full References chain. */
  references?: string[];
  attachments?: OutboundAttachment[];
  headers?: Record<string, string>;
}

/**
 * Abstracts CF Email Service binding, SMTP, SendGrid, Resend, etc.
 * CF implementation: `cfTransport(env.EMAIL)` in `@mvrx/mail/transports`.
 * SMTP implementation: `smtpTransport({ host, port, auth })` in `@mvrx/mail/transports`.
 */
export interface EmailTransport {
  send(message: OutboundEmail): Promise<{ messageId: string }>;
}

// ── NotificationBus ──────────────────────────────────────────────────────────

export type MailEventType =
  | "new_message"
  | "message_updated"
  | "thread_updated"
  | "rule_fired"
  | "attachment_ready";

export interface MailEvent {
  type: MailEventType;
  payload: Record<string, unknown>;
}

/**
 * Abstracts real-time fan-out to connected clients.
 * CF implementation: UserRelay Durable Object via `relayBus(env.RELAY)` in `@mvrx/mail/relay`.
 * For non-CF deployments: implement with WebSockets, SSE, or webhooks.
 */
export interface NotificationBus {
  publish(userId: string, event: MailEvent): Promise<void>;
}

// ── AiChatProvider ───────────────────────────────────────────────────────────

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Minimal LLM interface satisfied by any major provider.
 * Pre-built connectors in `@mvrx/mail/providers`:
 *   cfProvider, openaiProvider, anthropicProvider, geminiProvider,
 *   mistralProvider, azureProvider, ollamaProvider, openaiCompatProvider
 */
export interface AiChatProvider {
  run(
    model: string,
    messages: AiMessage[]
  ): Promise<{ text: string }>;
}

// ── PasswordVerifier ─────────────────────────────────────────────────────────

/**
 * Abstracts password hashing and verification for mailbox auth.
 * Default implementation uses Web Crypto PBKDF2 (works on CF Workers and all modern runtimes).
 * Replace with bcrypt or argon2 on Node.js environments where native modules are available.
 */
export interface PasswordVerifier {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}
