<div align="center">
<img src="./assets/logo.svg" width="56" height="56" alt="AECS logo" />

# MVRX

**Email infrastructure for AI agents.**

Open-source packages that turn raw RFC 5322/MIME email into normalized, AI-ready
data — plus the standalone protocol libraries that make it work.

[![CI](https://github.com/mvrxapp/mail/actions/workflows/ci.yml/badge.svg)](https://github.com/mvrxapp/mail/actions/workflows/ci.yml)
[![npm @mvrx/mail](https://img.shields.io/npm/v/@mvrx/mail.svg?label=%40mvrx%2Fmail)](https://www.npmjs.com/package/@mvrx/mail)
[![npm @mvrx/aecs](https://img.shields.io/npm/v/@mvrx/aecs.svg?label=%40mvrx%2Faecs)](https://www.npmjs.com/package/@mvrx/aecs)
[![npm @mvrx/wbxml](https://img.shields.io/npm/v/@mvrx/wbxml.svg?label=%40mvrx%2Fwbxml)](https://www.npmjs.com/package/@mvrx/wbxml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./packages/mail/LICENSE)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./packages/wbxml/LICENSE)
[![AECS-1](https://img.shields.io/badge/AECS--1-1.0.0-blueviolet.svg)](https://github.com/mvrxapp/aecs/blob/main/specs/AECS-1-ai-email-consumption.md)

</div>

---

## Why

Raw email is a bad input for LLMs. A single message is a MIME tree of encodings,
quoted reply chains, HTML markup, and inconsistent headers — feeding it straight into
a prompt burns context on boilerplate and gives the model no reliable way to tell
"what the sender actually wrote" from "what their client bolted on." Threading is
worse: `In-Reply-To` and `References` headers are sender-controlled and frequently
missing or wrong, so naive threading silently fragments or merges conversations.
`@mvrx/mail` normalizes a message once, deterministically, into a typed
`NormalizedEmail` object with a `content.forAI` field designed to be handed straight
to a model — so every consumer solves this problem the same way instead of
reinventing MIME parsing and quote-stripping heuristics.

## Quickstart

```bash
npm install @mvrx/mail
```

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

`parse()` accepts a raw string, stream, byte buffer, or a Cloudflare Email Worker
message, and returns a `NormalizedEmail` with a deterministic `threadId` and six
content levels. `email.content.forAI` is the one built for prompts — signatures and
quoted history stripped, whitespace normalized, wrapped in whatever delimiter you
asked for:

```xml
<email>
Thanks, that works for me — let's do Thursday at 2pm.
</email>
```

## Packages

| Package | npm | License | Description |
|---|---|---|---|
| [`packages/mail`](./packages/mail) | [![npm](https://img.shields.io/npm/v/@mvrx/mail.svg)](https://www.npmjs.com/package/@mvrx/mail) `@mvrx/mail` | AGPL-3.0-only | Cloudflare Email Routing SDK built on `@mvrx/aecs` |
| [mvrxapp/aecs](https://github.com/mvrxapp/aecs) | [![npm](https://img.shields.io/npm/v/@mvrx/aecs.svg)](https://www.npmjs.com/package/@mvrx/aecs) `@mvrx/aecs` | MIT | Framework-agnostic AECS-1 reference implementation (separate repo — the open standard) |
| [`packages/wbxml`](./packages/wbxml) | [![npm](https://img.shields.io/npm/v/@mvrx/wbxml.svg)](https://www.npmjs.com/package/@mvrx/wbxml) `@mvrx/wbxml` | MIT | Standalone WBXML parser/encoder for Exchange ActiveSync |

## Specification

**AECS-1** (v1.0.0, Final) is the open specification behind `@mvrx/mail`, maintained in its
own repo, [mvrxapp/aecs](https://github.com/mvrxapp/aecs): it defines `NormalizedEmail` —
the schema, the deterministic threading algorithm, timestamp normalization rules, and the
six content levels (`rawFull` / `raw` / `html` / `text` / `clean` / `forAI`). It's published
under **CC0 1.0** (public domain) so anyone can implement it, in any language, without
asking permission. `@mvrx/aecs` is the framework-agnostic, MIT-licensed reference
implementation of this spec, and `@mvrx/mail` depends on it rather than reimplementing it.

- [AECS-1 spec](https://github.com/mvrxapp/aecs/blob/main/specs/AECS-1-ai-email-consumption.md) — the normative document
- [JSON Schema](https://github.com/mvrxapp/aecs/blob/main/specs/schema/normalized-email.schema.json) — machine-checkable `NormalizedEmail` shape
- [Conformance suite](https://github.com/mvrxapp/aecs/tree/main/specs/conformance) — fixtures + an independent reference checker (`verify.py`) for the threading and timestamp rules
- [AECS-SDK-1](https://github.com/mvrxapp/aecs/blob/main/specs/AECS-SDK-1-specification.md) (v0.3.0-draft) — the broader SDK roadmap that `@mvrx/mail` implements against

## Documentation

The AECS-1 specification has a browsable home at
[mvrxapp.github.io/aecs](https://mvrxapp.github.io/aecs/). Full product docs are
launching soon at [mvrx.app/docs](https://mvrx.app/docs). Until then, the primary
references are:

- [`packages/mail/README.md`](./packages/mail/README.md) — SDK usage and content levels
- [`packages/wbxml/README.md`](./packages/wbxml/README.md) — WBXML API reference
- [mvrxapp/aecs](https://github.com/mvrxapp/aecs) — the AECS-1/AECS-SDK-1 specs, schema, and conformance suite

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All commits require a `Signed-off-by`
trailer (DCO) — add it automatically with `git commit -s`.

## Security

Report vulnerabilities privately — do not open a public issue. See
[SECURITY.md](./SECURITY.md) or email **security@mvrx.app** directly.

## License

This repo does not use a single license for everything. Each package carries its own
`LICENSE` file, which takes precedence over the root [`LICENSE`](./LICENSE):

- **`@mvrx/mail`** — AGPL-3.0-only. It is the AI email consumption SDK and the
  foundation the hosted service must use. A commercial license (no AGPL obligations)
  is available from MVRX Group for anyone who wants to embed it in a closed-source
  product.
- **`@mvrx/wbxml`** — MIT. It's a standalone protocol parser with no product logic,
  so it's licensed permissively to be freely embeddable — copyleft would only
  suppress its adoption as a general-purpose npm package.
