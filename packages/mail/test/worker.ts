// Test-only Worker entry: the vitest-pool-workers `main` so the UserHub Durable
// Object class is registered and reachable through the HUB binding in tests.
export { UserHub } from "../src/hub/index.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("test worker");
  },
};
