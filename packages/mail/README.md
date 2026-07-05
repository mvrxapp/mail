# @mvrx/mail

[![npm](https://img.shields.io/npm/v/@mvrx/mail.svg)](https://www.npmjs.com/package/@mvrx/mail)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)

AECS TypeScript SDK core for turning raw RFC 5322/MIME email into `NormalizedEmail`
objects that are useful to AI agents and modern applications.

## Install

```bash
npm install @mvrx/mail
```

## Current core

- `parse(source, options?)` for raw strings, streams, bytes, and Cloudflare `email()` messages
- AECS-1 deterministic `threadId` resolution
- UTC timestamp normalization
- `rawFull`, `raw`, `html`, `text`, `clean`, and `forAI` content levels
- HTML-to-text cleanup, conservative quote/signature stripping, and bounded `forAI`
- Lazy attachment metadata/content
- `EmailThread.from()` for deterministic thread ordering and thread-level AI context
- Prompt wrappers via `wrappers.xml()`, `wrappers.markdown()`, and `wrappers.block()`

## Example

```ts
import { parse, wrappers } from "@mvrx/mail";

export default {
  async email(message: ForwardableEmailMessage) {
    const email = await parse(message, {
      wrapper: wrappers.xml("email"),
    });

    await fetch("https://agent.example.com/inbox", {
      method: "POST",
      body: JSON.stringify({
        messageId: email.messageId,
        threadId: email.threadId,
        from: email.metadata.from,
        subject: email.metadata.subject,
        input: email.content.forAI,
      }),
    });
  },
};
```

## Content levels

`email.content` provides the same message body at six processing levels (AECS-1 §4.3):

| Field | What it is |
|---|---|
| `rawFull` | Complete original RFC 5322 message — all headers, MIME parts, encodings, exactly as received |
| `raw` | The latest message body only, quoted reply history stripped at the MIME level, headers excluded |
| `html` | HTML rendition of the latest message content (`null` if there's no HTML part) |
| `text` | Plain text rendition, decoded from any transfer encoding |
| `clean` | Plain text with signatures and quoted reply chains removed via heuristic detection |
| `forAI` | `clean`, further normalized (whitespace, collapsed forwarded-message headers, no inline image references) — the field AI consumers SHOULD use as their primary input |

## Status

The core parser is implemented. Storage, sending, rules, EAS, MCP, and the hosted-service
dashboard are later modules and must build on this public SDK surface rather than bypass it.

The normative structure is [AECS-1 v1.0.0](https://github.com/mvrxapp/aecs/blob/main/specs/AECS-1-ai-email-consumption.md).
The broader SDK roadmap is [AECS-SDK-1](https://github.com/mvrxapp/aecs/blob/main/specs/AECS-SDK-1-specification.md).
Full docs are launching soon at [mvrx.app/docs](https://mvrx.app/docs).

## License

AGPL-3.0-only. Commercial licensing is available from MVRX for closed-source embedding.
