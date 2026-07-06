import { describe, expect, it } from "vitest";
import type { Attachment } from "@mvrx/aecs";
import type { BlobPutOptions, BlobStore } from "../src/adapters.js";
import {
  attachmentsForAI,
  chain,
  cfPdfExtractor,
  ocr,
  pdfToText,
  runOcr,
  runTranscribe,
  storeToR2,
  transcribe,
  type AttachmentProcessor,
} from "../src/attachments/index.js";

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-1",
    filename: "note.txt",
    contentType: "text/plain",
    size: 5,
    cid: null,
    content: async () => new TextEncoder().encode("hello"),
    extractedText: null,
    blobKey: null,
    ...overrides,
  };
}

// ── attachmentsForAI ─────────────────────────────────────────────────────────

describe("attachmentsForAI", () => {
  it("returns null when no attachment has extractedText", () => {
    const atts = [makeAttachment({ extractedText: null }), makeAttachment({ extractedText: undefined })];
    expect(attachmentsForAI(atts)).toBeNull();
  });

  it("skips attachments without extractedText and wraps the rest with the default xml wrapper", () => {
    const atts = [
      makeAttachment({ filename: "a.txt", extractedText: null }),
      makeAttachment({ filename: "invoice.pdf", contentType: "application/pdf", extractedText: "Total due: $500" }),
    ];
    const result = attachmentsForAI(atts);
    expect(result).not.toBeNull();
    expect(result).toContain("<attachment>");
    expect(result).toContain("</attachment>");
    expect(result).toContain('name="invoice.pdf" type="application/pdf"');
    expect(result).toContain("Total due: $500");
    expect(result).not.toContain("a.txt");
  });

  it("truncates per-attachment text past maxCharsPerAttachment and notes the truncation", () => {
    const longText = "x".repeat(100);
    const atts = [makeAttachment({ extractedText: longText })];
    const result = attachmentsForAI(atts, { maxCharsPerAttachment: 10 })!;
    expect(result).toContain("x".repeat(10));
    expect(result).not.toContain("x".repeat(11));
    expect(result).toContain("[truncated — 10 chars shown of 100]");
  });

  it("caps total output length by dropping later blocks entirely", () => {
    const atts = [
      makeAttachment({ filename: "first.txt", extractedText: "first-block-text" }),
      makeAttachment({ filename: "second.txt", extractedText: "second-block-text" }),
    ];
    // maxTotalChars large enough for exactly the first wrapped block, too small for both.
    const firstOnly = attachmentsForAI(atts, { maxTotalChars: 10_000 })!;
    expect(firstOnly).toContain("first-block-text");
    expect(firstOnly).toContain("second-block-text");

    const capped = attachmentsForAI(atts, { maxTotalChars: 60 })!;
    expect(capped).toContain("first-block-text");
    expect(capped).not.toContain("second-block-text");
  });

  it("filters by content type using exact matches and globs", () => {
    const atts = [
      makeAttachment({ filename: "doc.pdf", contentType: "application/pdf", extractedText: "pdf text" }),
      makeAttachment({ filename: "photo.jpg", contentType: "image/jpeg", extractedText: "image text" }),
      makeAttachment({ filename: "clip.mp3", contentType: "audio/mpeg", extractedText: "audio text" }),
    ];

    const onlyImages = attachmentsForAI(atts, { include: ["image/*"] })!;
    expect(onlyImages).toContain("image text");
    expect(onlyImages).not.toContain("pdf text");
    expect(onlyImages).not.toContain("audio text");

    const exact = attachmentsForAI(atts, { include: ["application/pdf"] })!;
    expect(exact).toContain("pdf text");
    expect(exact).not.toContain("image text");
  });

  it("supports a custom label function and disabling the wrapper", () => {
    const atts = [makeAttachment({ filename: "report.pdf", extractedText: "body text" })];
    const result = attachmentsForAI(atts, {
      wrapper: null,
      label: (att) => `CUSTOM:${att.filename}`,
    })!;
    expect(result).not.toContain("<attachment>");
    expect(result).toContain('name="CUSTOM:report.pdf"');
    expect(result).toContain("body text");
  });
});

// ── chain ────────────────────────────────────────────────────────────────────

describe("chain", () => {
  it("composes an AttachmentProcessor and a handler fn, running in order and respecting accepts()", async () => {
    const order: string[] = [];

    const pdfOnly: AttachmentProcessor = {
      accepts: (att) => att.contentType === "application/pdf",
      process: (att) => {
        order.push("processor");
        att.extractedText = "from-processor";
      },
    };

    const alwaysRuns = async (att: Attachment) => {
      order.push("handler");
      att.blobKey = `stamped/${att.filename}`;
    };

    const handler = chain(pdfOnly, alwaysRuns);

    const pdfAtt = makeAttachment({ contentType: "application/pdf" });
    await handler(pdfAtt, { messageId: "msg-1" });
    expect(order).toEqual(["processor", "handler"]);
    expect(pdfAtt.extractedText).toBe("from-processor");
    expect(pdfAtt.blobKey).toBe("stamped/note.txt");

    order.length = 0;
    const txtAtt = makeAttachment({ contentType: "text/plain" });
    await handler(txtAtt, { messageId: "msg-1" });
    // pdfOnly.accepts() is false for text/plain, so only the handler runs.
    expect(order).toEqual(["handler"]);
    expect(txtAtt.extractedText).toBeNull();
  });
});

// ── storeToR2 ────────────────────────────────────────────────────────────────

describe("storeToR2", () => {
  function makeFakeBlobStore() {
    const puts: { key: string; value: Uint8Array | ArrayBuffer | string; options?: BlobPutOptions }[] = [];
    const store: BlobStore = {
      put: async (key, value, options) => {
        puts.push({ key, value, options });
      },
      get: async () => null,
      delete: async () => {},
      list: async () => [],
    };
    return { store, puts };
  }

  it("stores att.content() under att/<messageId>/<filename> and sets att.blobKey", async () => {
    const { store, puts } = makeFakeBlobStore();
    const handler = storeToR2(store);
    const att = makeAttachment({ filename: "invoice.pdf", contentType: "application/pdf" });

    await handler(att, { messageId: "msg-42" });

    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe("att/msg-42/invoice.pdf");
    expect(puts[0]!.options?.contentType).toBe("application/pdf");
    expect(att.blobKey).toBe("att/msg-42/invoice.pdf");
    // The spec's illustrative att.url doesn't exist on Attachment — only blobKey is set.
    expect((att as unknown as { url?: string }).url).toBeUndefined();
  });

  it("honors a custom keyPrefix", async () => {
    const { store, puts } = makeFakeBlobStore();
    const handler = storeToR2(store, { keyPrefix: "custom" });
    const att = makeAttachment({ filename: "a.txt" });

    await handler(att, { messageId: "msg-1" });

    expect(puts[0]!.key).toBe("custom/msg-1/a.txt");
    expect(att.blobKey).toBe("custom/msg-1/a.txt");
  });

  it("passes the publicUrl(key) result through to BlobStore.put options", async () => {
    const { store, puts } = makeFakeBlobStore();
    const handler = storeToR2(store, { publicUrl: (key) => `https://cdn.example.com/${key}` });
    const att = makeAttachment({ filename: "a.txt" });

    await handler(att, { messageId: "msg-1" });

    expect(puts[0]!.options?.publicUrl).toBe("https://cdn.example.com/att/msg-1/a.txt");
  });
});

// ── pdfToText ────────────────────────────────────────────────────────────────

describe("pdfToText", () => {
  it("sets extractedText from an injected extractor for application/pdf attachments", async () => {
    const handler = pdfToText({ extractor: async () => "extracted pdf text" });
    const att = makeAttachment({ contentType: "application/pdf" });

    await handler(att, { messageId: "msg-1" });

    expect(att.extractedText).toBe("extracted pdf text");
  });

  it("does nothing for non-pdf attachments", async () => {
    const handler = pdfToText({ extractor: async () => "should not be used" });
    const att = makeAttachment({ contentType: "text/plain" });

    await handler(att, { messageId: "msg-1" });

    expect(att.extractedText).toBeNull();
  });
});

// ── ocr / runOcr, transcribe / runTranscribe, cfPdfExtractor ─────────────────
//
// These fakes only assert the model id / input shape passed to `ai.run` and
// `ai.toMarkdown`, and that the result is threaded back onto `extractedText`.
// Real Workers AI extraction quality (actual OCR/transcription/PDF
// conversion accuracy) is verified only on deploy against the live `AI`
// binding, not by this offline unit test.

describe("ocr / runOcr", () => {
  it("calls the default llava model with image bytes and sets extractedText", async () => {
    const calls: { model: string; input: unknown }[] = [];
    const fakeAi = {
      run: async (model: string, input: unknown) => {
        calls.push({ model, input });
        return { description: "a photo of a cat" };
      },
    } as unknown as Ai;

    const handler = ocr({ ai: fakeAi });
    const att = makeAttachment({ contentType: "image/png", content: async () => new Uint8Array([1, 2, 3]) });

    await handler(att, { messageId: "msg-1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("@cf/llava-hf/llava-1.5-7b-hf");
    expect(calls[0]!.input).toMatchObject({
      image: [1, 2, 3],
      prompt: "Extract all text visible in this image.",
    });
    expect(att.extractedText).toBe("a photo of a cat");
  });

  it("skips non-image attachments", async () => {
    const fakeAi = { run: async () => ({ description: "unused" }) } as unknown as Ai;
    const handler = ocr({ ai: fakeAi });
    const att = makeAttachment({ contentType: "text/plain" });

    await handler(att, { messageId: "msg-1" });

    expect(att.extractedText).toBeNull();
  });

  it("runOcr honors a custom model and prompt", async () => {
    const calls: { model: string; input: unknown }[] = [];
    const fakeAi = {
      run: async (model: string, input: unknown) => {
        calls.push({ model, input });
        return { description: "custom result" };
      },
    } as unknown as Ai;

    const text = await runOcr(fakeAi, new Uint8Array([9, 9]), {
      model: "@cf/custom/vision",
      prompt: "Describe this",
    });

    expect(calls[0]!.model).toBe("@cf/custom/vision");
    expect(calls[0]!.input).toMatchObject({ image: [9, 9], prompt: "Describe this" });
    expect(text).toBe("custom result");
  });

  it("returns null when the model yields no description", async () => {
    const fakeAi = { run: async () => ({}) } as unknown as Ai;
    const text = await runOcr(fakeAi, new Uint8Array([1]));
    expect(text).toBeNull();
  });
});

describe("transcribe / runTranscribe", () => {
  it("calls the default whisper model with audio bytes and sets extractedText", async () => {
    const calls: { model: string; input: unknown }[] = [];
    const fakeAi = {
      run: async (model: string, input: unknown) => {
        calls.push({ model, input });
        return { text: "hello world" };
      },
    } as unknown as Ai;

    const handler = transcribe({ ai: fakeAi });
    const att = makeAttachment({ contentType: "audio/mpeg", content: async () => new Uint8Array([4, 5, 6]) });

    await handler(att, { messageId: "msg-1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("@cf/openai/whisper");
    expect(calls[0]!.input).toMatchObject({ audio: [4, 5, 6] });
    expect(att.extractedText).toBe("hello world");
  });

  it("skips non-audio attachments", async () => {
    const fakeAi = { run: async () => ({ text: "unused" }) } as unknown as Ai;
    const handler = transcribe({ ai: fakeAi });
    const att = makeAttachment({ contentType: "text/plain" });

    await handler(att, { messageId: "msg-1" });

    expect(att.extractedText).toBeNull();
  });

  it("runTranscribe forwards a language option and custom model", async () => {
    const calls: { model: string; input: unknown }[] = [];
    const fakeAi = {
      run: async (model: string, input: unknown) => {
        calls.push({ model, input });
        return { text: "bonjour" };
      },
    } as unknown as Ai;

    const text = await runTranscribe(fakeAi, new Uint8Array([1]), {
      model: "@cf/openai/whisper-large-v3-turbo",
      language: "fr",
    });

    expect(calls[0]!.model).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(calls[0]!.input).toMatchObject({ audio: [1], language: "fr" });
    expect(text).toBe("bonjour");
  });

  it("returns null when the model yields no text", async () => {
    const fakeAi = { run: async () => ({}) } as unknown as Ai;
    const text = await runTranscribe(fakeAi, new Uint8Array([1]));
    expect(text).toBeNull();
  });
});

describe("cfPdfExtractor", () => {
  it("calls ai.toMarkdown with a named document and returns the markdown data", async () => {
    const calls: unknown[] = [];
    const fakeAi = {
      toMarkdown: async (files: unknown) => {
        calls.push(files);
        return [{ id: "1", name: "document.pdf", mimeType: "application/pdf", format: "markdown", data: "# Invoice\nTotal: $100" }];
      },
    } as unknown as Ai;

    const extractor = cfPdfExtractor(fakeAi);
    const text = await extractor(new Uint8Array([1, 2, 3]));

    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0])).toBe(true);
    const [doc] = calls[0] as { name: string; blob: Blob }[];
    expect(doc!.name).toBe("document.pdf");
    expect(doc!.blob).toBeInstanceOf(Blob);
    expect(text).toBe("# Invoice\nTotal: $100");
  });

  it("returns null when conversion reports an error", async () => {
    const fakeAi = {
      toMarkdown: async () => [{ id: "1", name: "document.pdf", mimeType: "application/pdf", format: "error", error: "corrupt file" }],
    } as unknown as Ai;

    const extractor = cfPdfExtractor(fakeAi);
    const text = await extractor(new Uint8Array([1]));

    expect(text).toBeNull();
  });
});
