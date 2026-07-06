import { parse, d1Init, d1Store, loadRules, evaluateRules } from "@mvrx/mail";
import { cfTransport } from "@mvrx/mail/transports";
import { cfProvider } from "@mvrx/mail/providers";
import { classify } from "@mvrx/mail/ai-tools";
import { compose } from "@mvrx/mail/compose";
import { processors } from "@mvrx/mail/attachments";
import { publishEvent, hubRouter } from "@mvrx/mail/hub";

// Register the UserHub Durable Object (backs real-time SSE events).
export { UserHub } from "@mvrx/mail/hub";

interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  AI: Ai;
  EMAIL: SendEmail;
  HUB: DurableObjectNamespace;
  AGENT_MODEL_CLASSIFY: string;
  AGENT_MODEL_CHAT: string;
}

export default {
  // Inbound: parse (+ archive attachments to R2 and extract PDF text) → store →
  // run rules → notify connected clients → AI classify → auto-acknowledge.
  async email(message: ForwardableEmailMessage, env: Env) {
    const email = await parse(message, {
      // Attachment handlers run during parse: store bytes to R2, then pull text
      // out of PDFs via Workers AI so it's queryable / AI-ready.
      onAttachment: processors.chain(
        processors.storeToR2(env.BLOBS, { keyPrefix: "att" }),
        processors.pdfToText({ extractor: processors.cfPdfExtractor(env.AI) })
      ),
    });

    await d1Init(env.DB);
    await d1Store(env.DB, email);

    // Single-tenant default: the recipient address is the userId.
    const userId = message.to;

    // Evaluate stored rules (forward/auto-reply fire through the transport).
    const rules = await loadRules(env.DB);
    const results = await evaluateRules(email, rules, cfTransport(env.EMAIL));
    for (const r of results) {
      if (!r.matched) continue;
      await publishEvent(env.HUB, userId, {
        type: "rule_fired",
        payload: {
          ruleId: r.ruleId,
          messageId: email.messageId,
          threadId: email.threadId,
          actions: r.actions.map((a) => a.type),
        },
      });
    }

    // Push a real-time "new message" event to any connected SSE clients.
    await publishEvent(env.HUB, userId, {
      type: "new_message",
      payload: {
        messageId: email.messageId,
        threadId: email.threadId,
        from: email.metadata.from,
        subject: email.metadata.subject,
      },
    });

    // Classify with Workers AI.
    const ai = cfProvider(env.AI);
    const { category } = await classify(email, ai, { model: env.AGENT_MODEL_CLASSIFY });
    console.log({ messageId: email.messageId, category });

    // Auto-acknowledge with an AI-drafted reply, threaded correctly.
    const { body } = await compose.reply(email, ai, {
      intent: "acknowledge receipt and say we'll respond within one business day",
      tone: "friendly",
      model: env.AGENT_MODEL_CHAT,
    });

    await compose.send(
      {
        from: { name: "Support", email: "support@example.com" },
        to: [email.metadata.from],
        subject: `Re: ${email.metadata.subject ?? ""}`,
        inReplyTo: email.messageId,
        references: [...email.thread.references, email.messageId],
      },
      body,
      cfTransport(env.EMAIL)
    );
  },

  // Mount the real-time SSE endpoint: clients connect with `new EventSource("/hub")`.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/hub") {
      // Derive the userId from your auth in production; single-tenant demo below.
      const userId = url.searchParams.get("user") ?? "demo";
      return hubRouter(req, env.HUB, userId);
    }
    return new Response("AECS mail Worker — receive, store, rules, events, classify, reply");
  },
};
