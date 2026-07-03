# basic-worker

A minimal Cloudflare Email Worker showing `@mvrx/mail` end to end: it receives an
inbound message via the `email()` handler, normalizes it with `parse()`, and logs
the fields an AI agent would consume — `messageId`, `threadId`, sender, subject, and
`content.forAI` — wrapped with `wrappers.xml("email")`.

See [`src/index.ts`](./src/index.ts) for the handler and [`wrangler.jsonc`](./wrangler.jsonc)
for the bindings (D1, R2, Durable Objects, Workers AI, Queues, Email Routing) a full
`@mvrx/mail`-based worker typically needs — trim what you don't use.

## Run it

```bash
cd examples/basic-worker
npx wrangler dev
```

`wrangler dev` starts a local server; use `wrangler dev --test-scheduled` or the
[Email Workers local testing guide](https://developers.cloudflare.com/email-routing/email-workers/local-development/)
to simulate an inbound `email()` trigger without sending real mail.

This example doesn't send its own outbound requests anywhere — swap the `console.log`
in `src/index.ts` for whatever your agent's inbox endpoint expects.
