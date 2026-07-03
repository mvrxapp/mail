import assert from "node:assert/strict";
import test from "node:test";
import { decode, encode } from "../dist/index.js";

test("WBXML encodes and decodes a simple EAS tree", () => {
  const tree = {
    tag: "Sync",
    namespace: "AirSync",
    children: [
      {
        tag: "Collections",
        namespace: "AirSync",
        children: [
          {
            tag: "Collection",
            namespace: "AirSync",
            children: [
              { tag: "SyncKey", namespace: "AirSync", text: "0" },
              { tag: "CollectionId", namespace: "AirSync", text: "inbox" },
            ],
          },
        ],
      },
    ],
  };

  const decoded = decode(encode(tree));

  assert.equal(decoded.tag, "Sync");
  assert.equal(decoded.namespace, "AirSync");
  assert.equal(decoded.children[0].tag, "Collections");
  assert.equal(decoded.children[0].children[0].children[0].text, "0");
  assert.equal(decoded.children[0].children[0].children[1].text, "inbox");
});

test("WBXML requires page disambiguation for duplicate tag names", () => {
  assert.throws(() => encode({ tag: "Status" }), /Ambiguous EAS element/);
  assert.doesNotThrow(() => encode({ tag: "Status", namespace: "Ping", text: "1" }));
});
