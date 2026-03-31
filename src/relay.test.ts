import { describe, expect, test } from "bun:test";
import type { Channel, Frame } from "./channel/interface.ts";
import { Relay } from "./relay.ts";
import type { InputAction, Scene, SceneContinuation, SceneInput } from "./scene/interface.ts";
import type { Snapshot } from "./vt/snapshot.ts";

/** Minimal no-op snapshot for testing. */
const dummySnapshot = {} as Snapshot;

/** Create a minimal stub channel that captures the `send` callback. */
function stubChannel(name = "test"): Channel & { sendInput(input: SceneInput): void } {
  let sendFn: ((input: SceneInput) => void) | null = null;
  return {
    name,
    sendInput(input: SceneInput) {
      if (sendFn) sendFn(input);
    },
    async start(send) {
      sendFn = send;
    },
    async stop() {},
    receive() {},
  };
}

/** Create a minimal scene that returns `actions` from `encodeInput`. */
function stubScene(actions: InputAction[] | InputAction | null): Scene {
  return {
    priority: 0,
    get state() {
      return "stub";
    },
    detect() {
      return [];
    },
    continue(): SceneContinuation {
      return { events: [], firm: true };
    },
    encodeInput() {
      return actions;
    },
  };
}

describe("Relay.send", () => {
  test("writes scene-encoded string action to PTY", async () => {
    const written: string[] = [];
    const gw = new Relay({ write: (b) => written.push(b) });
    gw.replaceScenes([stubScene("hello\r")]);
    gw.update(dummySnapshot);

    const ch = stubChannel();
    await gw.addChannels([ch]);
    ch.sendInput({ type: "text", content: "ignored" });

    await gw.flush();
    expect(written).toEqual(["hello\r"]);
  });

  test("executes InputAction array with sleep between writes", async () => {
    const written: string[] = [];
    const timestamps: number[] = [];
    const gw = new Relay({
      write: (b) => {
        written.push(b);
        timestamps.push(Date.now());
      },
    });
    gw.replaceScenes([stubScene(["abc", { sleep: 20 }, "\r"])]);
    gw.update(dummySnapshot);

    const ch = stubChannel();
    await gw.addChannels([ch]);
    ch.sendInput({ type: "text", content: "x" });

    await gw.flush();
    expect(written).toEqual(["abc", "\r"]);
    expect(timestamps).toHaveLength(2);
    // The delay between writes should be at least ~20ms
    expect((timestamps[1] ?? 0) - (timestamps[0] ?? 0)).toBeGreaterThanOrEqual(15);
  });

  test("falls back to content + CR for text input", async () => {
    const written: string[] = [];
    const gw = new Relay({ write: (b) => written.push(b) });
    // No scenes — triggers default fallback
    gw.update(dummySnapshot);

    const ch = stubChannel();
    await gw.addChannels([ch]);
    ch.sendInput({ type: "text", content: "hello" });

    await gw.flush();
    expect(written).toEqual(["hello\r"]);
  });

  test("falls back to bare CR for empty text input", async () => {
    const written: string[] = [];
    const gw = new Relay({ write: (b) => written.push(b) });
    gw.update(dummySnapshot);

    const ch = stubChannel();
    await gw.addChannels([ch]);
    ch.sendInput({ type: "text", content: "" });

    await gw.flush();
    expect(written).toEqual(["\r"]);
  });

  test("ignores select input when no scene handles it", async () => {
    const written: string[] = [];
    const gw = new Relay({ write: (b) => written.push(b) });
    gw.update(dummySnapshot);

    const ch = stubChannel();
    await gw.addChannels([ch]);
    ch.sendInput({ type: "select", index: 0 });

    await gw.flush();
    expect(written).toEqual([]);
  });

  test("does nothing when write is not provided", async () => {
    const gw = new Relay();
    gw.update(dummySnapshot);

    const ch = stubChannel();
    await gw.addChannels([ch]);
    // Should not throw
    ch.sendInput({ type: "text", content: "hello" });
    await gw.flush();
  });

  test("handles single sleep action from scene", async () => {
    const written: string[] = [];
    const gw = new Relay({ write: (b) => written.push(b) });
    gw.replaceScenes([stubScene({ sleep: 5 })]);
    gw.update(dummySnapshot);

    const ch = stubChannel();
    await gw.addChannels([ch]);
    ch.sendInput({ type: "text", content: "x" });

    await gw.flush();
    expect(written).toEqual([]);
  });

  test("handles null from scene encodeInput (falls back to default)", async () => {
    const written: string[] = [];
    const gw = new Relay({ write: (b) => written.push(b) });
    gw.replaceScenes([stubScene(null)]);
    gw.update(dummySnapshot);

    const ch = stubChannel();
    await gw.addChannels([ch]);
    ch.sendInput({ type: "text", content: "hi" });

    await gw.flush();
    expect(written).toEqual(["hi\r"]);
  });
});

/** Create a channel that records received frames and stop calls. */
function recordingChannel(name = "rec"): Channel & { frames: Frame[]; stopped: boolean } {
  const frames: Frame[] = [];
  return {
    name,
    frames,
    stopped: false,
    async start() {},
    async stop() {
      this.stopped = true;
    },
    receive(frame) {
      frames.push(frame);
    },
  };
}

describe("Relay.addChannels / removeChannels", () => {
  test("addChannels makes channel receive subsequent updates", async () => {
    const relay = new Relay();
    const ch = recordingChannel();
    await relay.addChannels([ch]);

    relay.update(dummySnapshot);
    expect(ch.frames.length).toBe(1);
  });

  test("removeChannels stops channel from receiving updates", async () => {
    const relay = new Relay();
    const ch = recordingChannel();
    await relay.addChannels([ch]);

    relay.update(dummySnapshot);
    expect(ch.frames.length).toBe(1);

    await relay.removeChannels([ch]);
    relay.update(dummySnapshot);
    expect(ch.frames.length).toBe(1);
  });

  test("removeChannels does not stop channels not in the relay", async () => {
    const relay = new Relay();
    const ch1 = recordingChannel("ch1");
    const ch2 = recordingChannel("ch2");

    await relay.addChannels([ch1]);
    // ch2 was never added to this relay
    await relay.removeChannels([ch2]);

    expect(ch2.stopped).toBe(false);
    relay.update(dummySnapshot);
    expect(ch1.frames.length).toBe(1);
  });

  test("add and remove do not interfere with other channels", async () => {
    const relay = new Relay();
    const ch1 = recordingChannel("ch1");
    const ch2 = recordingChannel("ch2");

    await relay.addChannels([ch1]);
    await relay.addChannels([ch2]);

    relay.update(dummySnapshot);
    expect(ch1.frames.length).toBe(1);
    expect(ch2.frames.length).toBe(1);

    await relay.removeChannels([ch1]);
    relay.update(dummySnapshot);
    expect(ch1.frames.length).toBe(1);
    expect(ch2.frames.length).toBe(2);
  });
});
