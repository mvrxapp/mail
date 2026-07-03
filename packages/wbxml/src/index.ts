import { EAS_CODE_PAGES, nameByToken, tokenByName } from "./codepages.js";

export interface WbxmlNode {
  tag: string;
  namespace?: string;
  page?: number;
  attributes?: Record<string, string>;
  children?: WbxmlNode[];
  text?: string;
  opaque?: Uint8Array;
}

export interface DecodeOptions {
  codePage?: CodePageTable;
}

export interface EncodeOptions {
  codePage?: CodePageTable;
}

export type CodePageTable = Record<number, Record<number, string>>;

const SWITCH_PAGE = 0x00;
const END = 0x01;
const STR_I = 0x03;
const OPAQUE = 0xc3;

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

export function decode(buffer: Uint8Array | ArrayBuffer, options: DecodeOptions = {}): WbxmlNode {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const names = options.codePage ?? nameByToken;

  if (bytes[0] !== 0x03) {
    throw new Error(`Invalid WBXML: expected version 0x03, got 0x${bytes[0]?.toString(16)}`);
  }

  let pos = 1;
  let stringTableLength: number;
  [, pos] = readMbUint32(bytes, pos);
  [, pos] = readMbUint32(bytes, pos);
  [stringTableLength, pos] = readMbUint32(bytes, pos);
  pos += stringTableLength;

  let currentPage = 0;
  const root: InternalNode = { tag: "__root__", page: 0, children: [] };
  const stack: InternalNode[] = [root];

  while (pos < bytes.length) {
    const byte = bytes[pos++]!;

    if (byte === SWITCH_PAGE) {
      currentPage = bytes[pos++] ?? 0;
      continue;
    }

    if (byte === END) {
      const completed = stack.pop();
      const parent = stack[stack.length - 1];
      if (!completed || !parent) throw new Error("WBXML END without matching open element");
      parent.children.push(completed);
      continue;
    }

    if (byte === STR_I) {
      const start = pos;
      while (pos < bytes.length && bytes[pos] !== 0x00) pos++;
      appendText(stack, decoder.decode(bytes.subarray(start, pos)));
      pos++;
      continue;
    }

    if (byte === OPAQUE) {
      let length: number;
      [length, pos] = readMbUint32(bytes, pos);
      const data = bytes.subarray(pos, pos + length);
      pos += length;
      appendText(stack, decoder.decode(data));
      continue;
    }

    const hasAttributes = (byte & 0x80) !== 0;
    const hasContent = (byte & 0x40) !== 0;
    const token = byte & 0x3f;
    const tag = names[currentPage]?.[token];
    if (!tag) {
      throw new Error(
        `Unknown WBXML token: page=${currentPage} token=0x${token.toString(16)} raw=0x${byte.toString(16)}`,
      );
    }
    if (hasAttributes) throw new Error(`WBXML attributes are not supported for EAS tag ${tag}`);

    const node: InternalNode = { tag, namespace: tagNamespace(currentPage), page: currentPage, children: [] };
    if (hasContent) {
      stack.push(node);
    } else {
      const parent = stack[stack.length - 1];
      if (!parent) throw new Error("WBXML element outside root");
      parent.children.push(node);
    }
  }

  if (stack.length !== 1) {
    throw new Error(`WBXML decode ended with unclosed elements (stack depth ${stack.length})`);
  }

  const first = root.children[0];
  if (!first || typeof first === "string") throw new Error("WBXML decode produced no root element");
  return normalizeNode(first);
}

export function encode(node: WbxmlNode, options: EncodeOptions = {}): Uint8Array {
  const tokens = tableToTokens(options.codePage) ?? tokenByName;
  const bytes: number[] = [0x03, 0x01, 0x6a, 0x00];
  let currentPage = 0;

  function writeNode(input: WbxmlNode): void {
    const page = resolvePage(input, tokens);
    if (page !== currentPage) {
      bytes.push(SWITCH_PAGE, page);
      currentPage = page;
    }

    const token = tokens[page]?.[input.tag];
    if (token === undefined) throw new Error(`Unknown EAS element: page=${page} tag=${input.tag}`);

    const childNodes = input.children ?? [];
    const hasContent =
      input.text !== undefined ||
      input.opaque !== undefined ||
      childNodes.length > 0;

    bytes.push(hasContent ? token | 0x40 : token);

    if (!hasContent) return;
    for (const child of childNodes) writeNode(child);
    if (input.text !== undefined) {
      bytes.push(STR_I, ...encoder.encode(input.text), 0x00);
    }
    if (input.opaque !== undefined) {
      bytes.push(OPAQUE);
      writeMbUint32(bytes, input.opaque.length);
      bytes.push(...input.opaque);
    }
    bytes.push(END);
  }

  writeNode(node);
  return new Uint8Array(bytes);
}

export { EAS_CODE_PAGES };

interface InternalNode {
  tag: string;
  namespace?: string;
  page: number;
  children: Array<InternalNode | string>;
}

function appendText(stack: InternalNode[], text: string): void {
  const current = stack[stack.length - 1];
  if (!current) throw new Error("WBXML text outside any element");
  current.children.push(text);
}

function normalizeNode(node: InternalNode): WbxmlNode {
  const out: WbxmlNode = { tag: node.tag, namespace: node.namespace, page: node.page };
  const children: WbxmlNode[] = [];
  const text: string[] = [];
  for (const child of node.children) {
    if (typeof child === "string") text.push(child);
    else children.push(normalizeNode(child));
  }
  if (children.length) out.children = children;
  if (text.length) out.text = text.join("");
  return out;
}

function readMbUint32(bytes: Uint8Array, pos: number): [number, number] {
  let value = 0;
  for (;;) {
    const byte = bytes[pos++];
    if (byte === undefined) throw new Error("Unexpected end of WBXML mb_uint32");
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, pos];
  }
}

function writeMbUint32(out: number[], value: number): void {
  const groups: number[] = [];
  do {
    groups.push(value & 0x7f);
    value >>>= 7;
  } while (value > 0);
  for (let i = groups.length - 1; i >= 0; i--) {
    out.push(i > 0 ? groups[i]! | 0x80 : groups[i]!);
  }
}

function tableToTokens(table?: CodePageTable): Record<number, Record<string, number>> | null {
  if (!table) return null;
  const out: Record<number, Record<string, number>> = {};
  for (const [pageRaw, names] of Object.entries(table)) {
    const page = Number(pageRaw);
    out[page] = {};
    for (const [tokenRaw, tag] of Object.entries(names)) out[page]![tag] = Number(tokenRaw);
  }
  return out;
}

function resolvePage(node: WbxmlNode, tokens: Record<number, Record<string, number>>): number {
  if (node.page !== undefined) return node.page;
  if (node.namespace) {
    const fromNamespace = pageByNamespace(node.namespace);
    if (fromNamespace !== null) return fromNamespace;
  }
  const hits = Object.entries(tokens)
    .filter(([, pageTokens]) => pageTokens[node.tag] !== undefined)
    .map(([page]) => Number(page));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new Error(`Ambiguous EAS element ${node.tag}; set node.page or namespace`);
  }
  throw new Error(`Unknown EAS element: ${node.tag}`);
}

function tagNamespace(page: number): string | undefined {
  return namespaceByPage[page];
}

function pageByNamespace(namespace: string): number | null {
  const normalized = namespace.toLowerCase();
  for (const [page, name] of Object.entries(namespaceByPage)) {
    if (name.toLowerCase() === normalized) return Number(page);
  }
  return null;
}

const namespaceByPage: Record<number, string> = {
  0: "AirSync",
  1: "Contacts",
  2: "Email",
  4: "Calendar",
  6: "AirSyncBase",
  12: "FolderHierarchy",
  14: "Ping",
  17: "MoveItems",
  18: "Settings",
  21: "ComposeMail",
  23: "Notes",
};
