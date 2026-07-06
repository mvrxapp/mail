import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { UserHub, publishEvent, hubRouter, hubBus, toSseFrame, type MailEvent } from "../src/hub/index.js";

const newMessage: MailEvent = {
  type: "new_message",
  payload: {
    messageId: "m1@example.com",
    threadId: "t1@example.com",
    from: { name: "Ada", email: "ada@example.com" },
    subject: "Hello",
  },
};

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("toSseFrame", () => {
  it("formats a named SSE frame with JSON payload", () => {
    const frame = decode(toSseFrame(newMessage));
    expect(frame).toBe(
      `event: new_message\ndata: ${JSON.stringify(newMessage.payload)}\n\n`
    );
  });
});

describe("UserHub", () => {
  it("drops events when no client is connected (fire-and-forget)", async () => {
    await publishEvent(env.HUB, "nobody@example.com", newMessage); // must not throw
    const stub = env.HUB.get(env.HUB.idFromName("nobody@example.com"));
    const count = await runInDurableObject(stub, (instance: UserHub) => instance.connectionCount());
    expect(count).toBe(0);
  });

  it("delivers a published event to a connected SSE client", async () => {
    const res = await hubRouter(new Request("https://worker/hub"), env.HUB, "u1@example.com");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();

    await publishEvent(env.HUB, "u1@example.com", newMessage);

    const { value } = await reader.read();
    const frame = decode(value!);
    expect(frame).toContain("event: new_message");
    expect(frame).toContain(`"messageId":"m1@example.com"`);

    await reader.cancel();
  });

  it("routes different userIds to different DO instances", async () => {
    const resA = await hubRouter(new Request("https://worker/hub"), env.HUB, "a@example.com");
    const readerA = resA.body!.getReader();

    // Publish only to user b — user a's stream should NOT receive it.
    await publishEvent(env.HUB, "b@example.com", newMessage);

    const stubA = env.HUB.get(env.HUB.idFromName("a@example.com"));
    const stubB = env.HUB.get(env.HUB.idFromName("b@example.com"));
    const countA = await runInDurableObject(stubA, (i: UserHub) => i.connectionCount());
    const countB = await runInDurableObject(stubB, (i: UserHub) => i.connectionCount());
    expect(countA).toBe(1); // a is connected
    expect(countB).toBe(0); // b never connected

    await readerA.cancel();
  });
});

describe("hubBus", () => {
  it("adapts the namespace to a NotificationBus", async () => {
    const bus = hubBus(env.HUB);
    await bus.publish("c@example.com", newMessage); // must not throw
    expect(typeof bus.publish).toBe("function");
  });
});
