# Changelog

All notable changes to the packages in this repo are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and each package adheres to [Semantic Versioning](https://semver.org/).

## @mvrx/mail

### [0.1.0] - 2026-07-03

Initial release. Implements the core of [AECS-1 v1.0.0](./specs/AECS-1-ai-email-consumption.md).

#### Added

- `parse(source, options?)` — normalizes raw strings, streams, byte buffers, and
  Cloudflare `email()` messages into a `NormalizedEmail` object.
- Deterministic `threadId` resolution per AECS-1 §5.
- UTC timestamp normalization per AECS-1 §6.
- Six content levels: `rawFull`, `raw`, `html`, `text`, `clean`, and `forAI`.
- HTML-to-text cleanup, conservative quote/signature stripping, and bounded `forAI`
  output.
- Lazy attachment metadata and content loading.
- `EmailThread.from()` for deterministic thread ordering and thread-level AI context.
- Prompt wrappers: `wrappers.xml()`, `wrappers.markdown()`, and `wrappers.block()`.

## @mvrx/wbxml

### [0.1.0] - 2026-07-03

Initial release.

#### Added

- `decode(buffer, options?)` — parses a WBXML binary payload into a `WbxmlNode`
  element tree.
- `encode(node, options?)` — serializes a `WbxmlNode` element tree back into a
  WBXML binary payload.
- Full EAS 14.1 code-page table (`EAS_CODE_PAGES`), covering `AirSync`, `Contacts`,
  `Email`, `Calendar`, `AirSyncBase`, `FolderHierarchy`, `Ping`, `MoveItems`,
  `Settings`, `ComposeMail`, and `Notes`.
- Zero dependencies; runs on Cloudflare Workers, Node.js 18+, Deno, Bun, and browsers.
