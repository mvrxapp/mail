// Types for the Miniflare bindings provided by vitest.config.ts to `cloudflare:test`.
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    BLOBS: R2Bucket;
    CACHE: KVNamespace;
    HUB: DurableObjectNamespace;
  }
}
