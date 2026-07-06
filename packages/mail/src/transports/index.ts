import type { Address } from "@mvrx/aecs";
import type {
  BlobObject,
  BlobPutOptions,
  BlobStore,
  EmailTransport,
  OutboundAttachment,
  OutboundEmail,
} from "../adapters.js";

/**
 * Outbound transports for @mvrx/mail (AECS-SDK-1 §3.5).
 *
 * `cfTransport` sends via the Cloudflare Email Routing `SendEmail` binding.
 * `smtpTransport` targets Node/Bun/Deno runtimes with raw SMTP.
 */

// ── RFC 5322 / MIME construction ────────────────────────────────────────────

const CRLF = "\r\n";

function formatAddress(addr: Address): string {
  if (!addr.name) return addr.email;
  const needsQuotes = /[",;<>()]/.test(addr.name);
  const name = needsQuotes ? `"${addr.name.replace(/"/g, '\\"')}"` : addr.name;
  return `${name} <${addr.email}>`;
}

function formatAddressList(addrs: Address[]): string {
  return addrs.map(formatAddress).join(", ");
}

/** Generates an RFC 5322 Message-ID using the sender's domain. */
export function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] ?? "localhost";
  return `<${crypto.randomUUID()}@${domain}>`;
}

/** Encodes bytes as base64, wrapped at 76 chars per RFC 2045. */
function encodeBase64(content: Uint8Array | string): string {
  let base64: string;
  if (typeof content === "string") {
    // Per the OutboundAttachment contract, a string content is already base64.
    base64 = content;
  } else {
    let binary = "";
    for (let i = 0; i < content.length; i++) binary += String.fromCharCode(content[i]);
    base64 = btoa(binary);
  }
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 76) lines.push(base64.slice(i, i + 76));
  return lines.join(CRLF);
}

function newBoundary(label: string): string {
  return `mvrx-${label}-${crypto.randomUUID()}`;
}

interface BodyPart {
  headers: string[];
  body: string;
}

function textPart(contentType: string, body: string): BodyPart {
  return {
    headers: [`Content-Type: ${contentType}; charset="UTF-8"`, `Content-Transfer-Encoding: 8bit`],
    body: body.replace(/\r?\n/g, CRLF),
  };
}

function attachmentPart(attachment: OutboundAttachment): BodyPart {
  const disposition = attachment.cid ? "inline" : "attachment";
  const headers = [
    `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: ${disposition}; filename="${attachment.filename}"`,
  ];
  if (attachment.cid) headers.push(`Content-ID: <${attachment.cid}>`);
  return { headers, body: encodeBase64(attachment.content) };
}

function renderParts(boundary: string, parts: BodyPart[]): string {
  return (
    parts
      .map((part) => `--${boundary}${CRLF}${part.headers.join(CRLF)}${CRLF}${CRLF}${part.body}`)
      .join(CRLF) + `${CRLF}--${boundary}--`
  );
}

function buildCorePart(message: OutboundEmail): BodyPart {
  const hasText = message.text != null;
  const hasHtml = message.html != null;

  if (hasText && hasHtml) {
    const boundary = newBoundary("alt");
    const body = renderParts(boundary, [textPart("text/plain", message.text!), textPart("text/html", message.html!)]);
    return { headers: [`Content-Type: multipart/alternative; boundary="${boundary}"`], body };
  }

  if (hasHtml) return textPart("text/html", message.html!);
  return textPart("text/plain", message.text ?? "");
}

/**
 * Builds a raw RFC 5322 MIME message from an `OutboundEmail`. Exported
 * standalone so it can be unit-tested deterministically without a live
 * Email binding.
 */
export function buildMime(message: OutboundEmail, messageId: string): string {
  const headers: string[] = [];
  headers.push(`From: ${formatAddress(message.from)}`);
  headers.push(`To: ${formatAddressList(message.to)}`);
  if (message.cc && message.cc.length > 0) headers.push(`Cc: ${formatAddressList(message.cc)}`);
  headers.push(`Subject: ${message.subject}`);
  headers.push(`Message-ID: ${messageId}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  if (message.inReplyTo) headers.push(`In-Reply-To: ${message.inReplyTo}`);
  if (message.references && message.references.length > 0) {
    headers.push(`References: ${message.references.join(" ")}`);
  }
  headers.push(`MIME-Version: 1.0`);
  if (message.headers) {
    for (const [key, value] of Object.entries(message.headers)) headers.push(`${key}: ${value}`);
  }

  const core = buildCorePart(message);
  let bodyPart: BodyPart;
  if (message.attachments && message.attachments.length > 0) {
    const boundary = newBoundary("mixed");
    bodyPart = {
      headers: [`Content-Type: multipart/mixed; boundary="${boundary}"`],
      body: renderParts(boundary, [core, ...message.attachments.map(attachmentPart)]),
    };
  } else {
    bodyPart = core;
  }

  headers.push(...bodyPart.headers);

  return headers.join(CRLF) + CRLF + CRLF + bodyPart.body;
}

// ── cfTransport ──────────────────────────────────────────────────────────────

/**
 * Builds a transport backed by the Cloudflare Email Routing send binding
 * (`env.EMAIL` typed as `SendEmail`). Workers-only.
 *
 * `EmailMessage` is imported dynamically from `cloudflare:email` inside
 * `send()` rather than at module top-level: that module is only resolvable
 * inside the Workers runtime (or vitest-pool-workers), and a static
 * top-level import would make this whole file — including `buildMime`,
 * which is plain, portable MIME-building logic — unloadable outside that
 * runtime. `buildMime` is unit-tested directly for this reason.
 *
 * Note: `EmailMessage` carries a single envelope recipient, so the envelope
 * `to` is the first address in `message.to`; every recipient (`to`/`cc`) is
 * still listed in the rendered MIME headers for display purposes.
 */
export function cfTransport(binding: SendEmail): EmailTransport {
  return {
    async send(message: OutboundEmail): Promise<{ messageId: string }> {
      const envelopeTo = message.to[0]?.email;
      if (!envelopeTo) throw new Error("cfTransport: OutboundEmail.to must contain at least one address");

      const messageId = generateMessageId(message.from.email);
      const raw = buildMime(message, messageId);

      const { EmailMessage } = await import("cloudflare:email");
      await binding.send(new EmailMessage(message.from.email, envelopeTo, raw));

      return { messageId };
    },
  };
}

// ── smtpTransport ────────────────────────────────────────────────────────────

export interface SmtpTransportOptions {
  host: string;
  port: number;
  auth: { user: string; pass: string };
  secure?: boolean;
}

/**
 * Builds a transport that speaks SMTP directly (Node.js, Bun, Deno; also
 * usable from Cloudflare Workers against `smtp.mx.cloudflare.net:587` via
 * `cloudflare:sockets`).
 *
 * DECISION (b): this package ships with no SMTP client dependency and no
 * single raw-socket API portable across its target runtimes (Node's
 * `net`/`tls`, Bun sockets, and Cloudflare's `cloudflare:sockets` are three
 * different, non-interchangeable APIs). Hand-rolling a minimal
 * SMTP/STARTTLS/AUTH state machine here — with no live SMTP server available
 * to validate it against in this environment — risks silently corrupting or
 * dropping outbound mail, which is worse than failing loudly. Rather than
 * fake a successful send, this transport throws and directs the caller to
 * supply their own `EmailTransport` (e.g. wrapping `nodemailer` on Node, or
 * a `cloudflare:sockets`-based SMTP client in a Worker).
 */
export function smtpTransport(options: SmtpTransportOptions): EmailTransport {
  return {
    async send(_message: OutboundEmail): Promise<{ messageId: string }> {
      throw new Error(
        `smtpTransport: no built-in SMTP client is bundled with @mvrx/mail. ` +
          `Delivering to ${options.host}:${options.port} requires a runtime-specific ` +
          `raw-socket/SMTP implementation (Node "net"/"tls", Bun sockets, or Cloudflare ` +
          `"cloudflare:sockets"). Implement an EmailTransport backed by a library such as ` +
          `nodemailer (Node) or a "cloudflare:sockets" SMTP client (Workers), and pass it ` +
          `to sendEmail() instead of smtpTransport().`
      );
    },
  };
}

// ── BlobStore ────────────────────────────────────────────────────────────────

/**
 * Wraps a Cloudflare R2 bucket binding as a `BlobStore` (adapters.ts). Lets the
 * storage-agnostic SDK (e.g. `storeToR2` in `@mvrx/mail/attachments`) target R2
 * without depending on the raw binding type.
 */
export function r2BlobStore(bucket: R2Bucket): BlobStore {
  return {
    async put(key, value, options?: BlobPutOptions): Promise<void> {
      await bucket.put(key, value, {
        httpMetadata: options?.contentType
          ? { contentType: options.contentType }
          : undefined,
      });
    },
    async get(key): Promise<Uint8Array | null> {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
    async delete(key): Promise<void> {
      await bucket.delete(key);
    },
    async list(prefix): Promise<BlobObject[]> {
      const listed = await bucket.list({ prefix });
      return listed.objects.map((o) => ({
        key: o.key,
        size: o.size,
        contentType: o.httpMetadata?.contentType ?? null,
      }));
    },
  };
}

export type {
  BlobStore,
  BlobPutOptions,
  BlobObject,
  EmailTransport,
  OutboundEmail,
  OutboundAttachment,
} from "../adapters.js";
