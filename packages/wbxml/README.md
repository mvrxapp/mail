# @mvrx/wbxml

[![npm](https://img.shields.io/npm/v/@mvrx/wbxml.svg)](https://www.npmjs.com/package/@mvrx/wbxml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Zero-dependency WBXML parser and encoder for Exchange ActiveSync 14.1.

Works on **Cloudflare Workers, Node.js 18+, Deno, Bun, and browsers** — no native modules, no Node.js APIs.

## Install

```bash
npm install @mvrx/wbxml
```

## Usage

```typescript
import { decode, encode } from "@mvrx/wbxml";

// Parse a WBXML binary buffer from an EAS response
const tree = decode(wbxmlBuffer);
console.log(tree.tag);           // "Sync"
console.log(tree.children);     // [{ tag: "Collections", ... }]

// Build and encode an EAS request
const buffer = encode({
  tag: "Sync",
  namespace: "AirSync",
  children: [
    {
      tag: "Collections",
      children: [
        {
          tag: "Collection",
          children: [
            { tag: "SyncKey", text: "0" },
            { tag: "CollectionId", text: "inbox" },
          ],
        },
      ],
    },
  ],
});
```

## API

### `decode(buffer, options?): WbxmlNode`

Parses a WBXML binary payload into an element tree.

```typescript
function decode(buffer: Uint8Array | ArrayBuffer, options?: DecodeOptions): WbxmlNode;

interface DecodeOptions {
  codePage?: CodePageTable;
}
```

`options.codePage` overrides the default EAS 14.1 code-page table (`nameByToken`) — useful
if you need to decode against a custom or extended tag set.

### `encode(node, options?): Uint8Array`

Serializes an element tree back into a WBXML binary payload.

```typescript
function encode(node: WbxmlNode, options?: EncodeOptions): Uint8Array;

interface EncodeOptions {
  codePage?: CodePageTable;
}
```

`options.codePage` overrides the default token table (`tokenByName`) used to resolve each
node's tag to a WBXML token.

### `WbxmlNode`

The element tree shape shared by `decode()` output and `encode()` input:

```typescript
interface WbxmlNode {
  tag: string;
  namespace?: string;              // e.g. "AirSync", "Contacts", "Email", "Calendar" — see EAS_CODE_PAGES
  page?: number;                   // WBXML code page; inferred from namespace/tag if omitted on encode
  attributes?: Record<string, string>; // decode throws if the payload contains attributes — EAS doesn't use them
  children?: WbxmlNode[];
  text?: string;
  opaque?: Uint8Array;              // raw opaque data (e.g. binary blobs) instead of text
}
```

### `EAS_CODE_PAGES`

The default EAS 14.1 code-page table (tag ⇄ token mappings per page), re-exported for
callers who want to build a custom `CodePageTable`.

## Runtime compatibility

| Runtime | Supported |
|---|---|
| Cloudflare Workers | ✓ |
| Node.js 18+ | ✓ |
| Deno | ✓ |
| Bun | ✓ |
| Browser | ✓ |

## License

MIT — licensed separately from `@mvrx/mail` (AGPL-3.0-only). As a standalone protocol
parser with no product logic, `@mvrx/wbxml` is permissively licensed so it can be freely
embedded in any project, proprietary or otherwise. See [`LICENSE`](./LICENSE).
