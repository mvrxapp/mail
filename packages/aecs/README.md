# @mvrx/aecs

[![npm](https://img.shields.io/npm/v/@mvrx/aecs.svg)](https://www.npmjs.com/package/@mvrx/aecs)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Reference implementation of **AECS-1** (AI-ready Email Consumption Standard) — an open
standard for deterministically normalizing raw RFC 5322/MIME email into AI-ready JSON.

This package is the framework-agnostic, zero-infrastructure-dependency implementation of
the spec: parsing, content cleaning, threading, and message normalization, with no
Cloudflare or storage assumptions baked in.

The full spec lives at [`./specs/AECS-1-ai-email-consumption.md`](./specs/AECS-1-ai-email-consumption.md).

## Install

```bash
npm install @mvrx/aecs
```

## Usage

```typescript
import { parse } from "@mvrx/aecs";

const email = await parse(rawRfc5322Message);

console.log(email.messageId);       // normalized Message-ID
console.log(email.threadId);        // deterministic thread identifier
console.log(email.content.clean);   // quote-stripped, signature-stripped body
console.log(email.content.forAI);   // wrapped, AI-ready representation
```

`parse()` accepts a raw message as a `string`, `ArrayBuffer`, `Uint8Array`, or a
`ReadableStream<Uint8Array>`.

## License

MIT. See [`LICENSE`](./LICENSE). This package is licensed separately from `@mvrx/mail`
(AGPL-3.0-only), which depends on it.
