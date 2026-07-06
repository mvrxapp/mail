// Test-only Worker entry: the vitest-pool-workers `main` so the UserRelay Durable
// Object class is registered and reachable through the RELAY binding in tests.
export { UserRelay } from "../src/relay/index.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("test worker");
  },
};
