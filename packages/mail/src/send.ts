import type { EmailTransport, OutboundEmail } from "./adapters.js";

/**
 * Standalone outbound send for forwarding, rule-triggered delivery, and
 * programmatic sends without the compose layer (AECS-SDK-1 §3.6).
 *
 * The transport owns MIME construction and threading-header placement;
 * this is a thin delegation so callers have one entry point regardless of
 * which transport they configured.
 */
export async function sendEmail(message: OutboundEmail, transport: EmailTransport): Promise<{ messageId: string }> {
  return transport.send(message);
}
