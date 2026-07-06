import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs tests inside workerd (Miniflare) so D1, R2, KV, and AI bindings are real,
// not mocked. Bindings are declared inline here so the harness is self-contained.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Worker entry that registers the UserRelay Durable Object so the RELAY
      // binding resolves to it in tests.
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["BLOBS"],
        kvNamespaces: ["CACHE"],
        durableObjects: { RELAY: "UserRelay" },
      },
    }),
  ],
});
