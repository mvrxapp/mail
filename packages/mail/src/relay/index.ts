import { DurableObject } from "cloudflare:workers";
import type { Address } from "@mvrx/aecs";
import type { MailEvent as LooseMailEvent, NotificationBus } from "../adapters.js";

/**
 * Real-time events for @mvrx/mail (AECS-SDK-1 §16).
 *
 * `UserRelay` is a Durable Object — one instance per user, keyed by an opaque
 * `userId` — that holds open Server-Sent Events (SSE) connections and fans out
 * `MailEvent`s to them. `publishEvent`/`relayRouter`/`relayBus` are the SDK helpers
 * that route through the DO.
 *
 * Delivery is fire-and-forget, at-most-once, with NO replay (§16.5): if no
 * client is connected when an event is published, it is dropped. Events are
 * "something changed, go refetch" signals; the source of truth is D1
 * (getThread/getMessage/listMessages). Clients reconcile against D1 on connect.
 *
 * Cost note (§16.4): each SSE connection holds a ReadableStream open, keeping
 * the DO instance active for the connection's lifetime — this is NOT WebSocket
 * Hibernation. At scale, reimplement NotificationBus over hibernatable
 * WebSockets if per-connection cost matters; nothing else in the SDK depends on
 * SSE specifically.
 */

// ── MailEvent (typed discriminated union, §16.2) ─────────────────────────────

export type MailEvent =
  | {
      type: "new_message";
      payload: { messageId: string; threadId: string; from: Address; subject: string | null };
    }
  | {
      type: "message_updated";
      payload: { messageId: string; read?: boolean; starred?: boolean; folder?: string };
    }
  | {
      type: "thread_updated";
      payload: { threadId: string; messageCount: number; lastAt: number };
    }
  | {
      type: "rule_fired";
      payload: { ruleId: string; messageId: string; threadId: string; actions: string[] };
    }
  | {
      type: "attachment_ready";
      payload: { messageId: string; attachmentId: string; extractedText: boolean };
    };

// The typed union above must stay assignable to the looser adapters.ts MailEvent
// ({ type: MailEventType; payload: Record<string, unknown> }) so UserRelay can
// satisfy NotificationBus. This assertion fails the build if they ever diverge.
const _assertAssignable: LooseMailEvent = null as unknown as MailEvent;
void _assertAssignable;

// ── SSE framing ──────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** Serializes a MailEvent as a named SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function toSseFrame(event: MailEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
}

const KEEPALIVE_MS = 25_000;
const KEEPALIVE_FRAME = encoder.encode(": keep-alive\n\n");

// ── UserRelay Durable Object ───────────────────────────────────────────────────

/**
 * One instance per user. Holds the set of open SSE stream controllers and fans
 * `MailEvent`s out to them. Register the class in wrangler with a DO binding +
 * migration (see the example worker), then `export { UserRelay } from "@mvrx/mail/relay"`.
 */
export class UserRelay extends DurableObject {
  private controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal publish: fan out to every connected client.
    if (url.pathname === "/publish") {
      const event = (await request.json()) as MailEvent;
      const frame = toSseFrame(event);
      for (const controller of this.controllers) {
        try {
          controller.enqueue(frame);
        } catch {
          this.controllers.delete(controller);
        }
      }
      return new Response(null, { status: 204 });
    }

    // Client connect: open a long-lived SSE stream.
    if (url.pathname === "/connect") {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controllers.add(controller);
          if (this.keepAlive === null) {
            this.keepAlive = setInterval(() => this.ping(), KEEPALIVE_MS);
          }
        },
        cancel: (controller) => {
          this.controllers.delete(controller as ReadableStreamDefaultController<Uint8Array>);
          this.stopKeepAliveIfIdle();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    return new Response("not found", { status: 404 });
  }

  /** Number of currently-connected SSE clients (useful for tests/observability). */
  connectionCount(): number {
    return this.controllers.size;
  }

  private ping(): void {
    for (const controller of this.controllers) {
      try {
        controller.enqueue(KEEPALIVE_FRAME);
      } catch {
        this.controllers.delete(controller);
      }
    }
    this.stopKeepAliveIfIdle();
  }

  private stopKeepAliveIfIdle(): void {
    if (this.controllers.size === 0 && this.keepAlive !== null) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }
}

// ── SDK helpers ──────────────────────────────────────────────────────────────

function stubFor(relay: DurableObjectNamespace, userId: string): DurableObjectStub {
  return relay.get(relay.idFromName(userId));
}

/**
 * Publish a `MailEvent` to a user's connected clients. Fire-and-forget: if the
 * user has no open connection, the event is dropped (§16.5). Callable from any
 * Worker handler.
 */
export async function publishEvent(
  relay: DurableObjectNamespace,
  userId: string,
  event: MailEvent
): Promise<void> {
  await stubFor(relay, userId).fetch("https://user-relay/publish", {
    method: "POST",
    body: JSON.stringify(event),
  });
}

/**
 * Mount as an SSE endpoint. Returns a `text/event-stream` Response that stays
 * open and streams this user's `MailEvent`s. Wire it into your fetch handler:
 * `if (url.pathname === "/relay") return relayRouter(req, env.RELAY, getUserId(req))`.
 */
export async function relayRouter(
  _req: Request,
  relay: DurableObjectNamespace,
  userId: string
): Promise<Response> {
  return stubFor(relay, userId).fetch("https://user-relay/connect");
}

/**
 * Adapts a UserRelay DO namespace to the `NotificationBus` interface (adapters.ts),
 * so it can be passed anywhere a generic bus is expected.
 */
export function relayBus(relay: DurableObjectNamespace): NotificationBus {
  return {
    publish: (userId, event) => publishEvent(relay, userId, event as MailEvent),
  };
}
