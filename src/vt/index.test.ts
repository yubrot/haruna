import { describe, expect, test } from "bun:test";
import { VirtualTerminal } from "./index.ts";
import {
  type RichText,
  richTextToPlainText,
  type Snapshot,
} from "./snapshot.ts";

const encoder = new TextEncoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function createMonitor(
  overrides?: Partial<{
    cols: number;
    rows: number;
    scrollback: number;
    debounceMs: number;
    maxIntervalMs: number;
  }>,
): {
  monitor: VirtualTerminal;
  waitForChange: () => Promise<{
    snapshot: Snapshot;
    previous: Snapshot | undefined;
  }>;
  changes: { snapshot: Snapshot; previous: Snapshot | undefined }[];
} {
  const changes: { snapshot: Snapshot; previous: Snapshot | undefined }[] = [];
  const pending: ((value: {
    snapshot: Snapshot;
    previous: Snapshot | undefined;
  }) => void)[] = [];

  const monitor = new VirtualTerminal({
    cols: 80,
    rows: 24,
    scrollback: 0,
    debounceMs: 50,
    ...overrides,
    onChange(snapshot, previous) {
      changes.push({ snapshot, previous });
      for (const resolve of pending.splice(0)) {
        resolve({ snapshot, previous });
      }
    },
  });

  function waitForChange(): Promise<{
    snapshot: Snapshot;
    previous: Snapshot | undefined;
  }> {
    return new Promise((resolve) => {
      pending.push(resolve);
    });
  }

  return { monitor, waitForChange, changes };
}

describe("VirtualTerminal", () => {
  test("fires onChange after text write settles", async () => {
    const { monitor, waitForChange } = createMonitor();
    const change = waitForChange();

    monitor.write(encode("hello world"));
    const { snapshot, previous } = await change;

    expect(richTextToPlainText(snapshot.lines[0] as RichText)).toContain(
      "hello world",
    );
    expect(previous).toBeUndefined();

    monitor.dispose();
  });

  test("debounces rapid writes into single callback", async () => {
    const { monitor, changes } = createMonitor();

    monitor.write(encode("a"));
    await Bun.sleep(20);
    monitor.write(encode("b"));
    await Bun.sleep(20);
    monitor.write(encode("c"));

    await Bun.sleep(80);
    expect(changes).toHaveLength(1);

    monitor.dispose();
  });

  test("does not fire when same data produces identical snapshot", async () => {
    const { monitor, waitForChange, changes } = createMonitor();

    // First write — should fire
    const first = waitForChange();
    monitor.write(encode("static"));
    await first;

    const countBefore = changes.length;

    // Move cursor to home and write same text
    monitor.write(encode("\x1b[H" + "static"));
    await Bun.sleep(80);

    expect(changes).toHaveLength(countBefore);

    monitor.dispose();
  });

  test("detects cursor hide via DECTCEM escape sequence", async () => {
    const { monitor, waitForChange } = createMonitor();
    const change = waitForChange();

    monitor.write(encode("\x1b[?25l"));
    const { snapshot } = await change;

    expect(snapshot.cursor.visible).toBe(false);

    monitor.dispose();
  });

  test("detects cursor movement sequences", async () => {
    const { monitor, waitForChange } = createMonitor();
    const change = waitForChange();

    // CUP: move cursor to row 5, col 10 (1-based)
    monitor.write(encode("\x1b[5;10H"));
    const { snapshot } = await change;

    expect(snapshot.cursor).toMatchObject({ x: 9, y: 0 }); // end-based

    monitor.dispose();
  });

  test("detects resize", async () => {
    const { monitor, waitForChange } = createMonitor();

    // Trigger initial change
    const first = waitForChange();
    monitor.write(encode("init"));
    await first;

    // Resize and write to trigger settle
    const change = waitForChange();
    monitor.resize(120, 40);
    monitor.write(encode(" ")); // trigger settle via notify
    const { snapshot } = await change;

    expect(snapshot).toMatchObject({ cols: 120, rows: 40 });

    monitor.dispose();
  });

  test("flush processes pending settle immediately", async () => {
    const { monitor, changes } = createMonitor({ debounceMs: 5000 });

    monitor.write(encode("flushed"));
    expect(changes).toHaveLength(0); // debounce has not fired

    await monitor.flush();
    expect(changes).toHaveLength(1);
    expect(
      richTextToPlainText(changes[0]?.snapshot.lines[0] as RichText),
    ).toContain("flushed");

    monitor.dispose();
  });

  test("takeSnapshot returns current state without debounce", () => {
    const { monitor } = createMonitor({ debounceMs: 5000 });

    monitor.write(encode("immediate"));
    // xterm.js processes async, so takeSnapshot may not have the data yet
    // But the method should return immediately without waiting for debounce
    const snap = monitor.takeSnapshot();
    expect(snap).toMatchObject({ cols: 80, rows: 24 });

    monitor.dispose();
  });

  test("lastSnapshot tracks the most recent settled snapshot", async () => {
    const { monitor, waitForChange } = createMonitor();

    expect(monitor.lastSnapshot).toBeUndefined();

    const change = waitForChange();
    monitor.write(encode("first"));
    await change;

    expect(monitor.lastSnapshot).toBeDefined();
    expect(
      richTextToPlainText(monitor.lastSnapshot?.lines[0] as RichText),
    ).toContain("first");

    monitor.dispose();
  });

  test("provides previous snapshot in callback", async () => {
    const { monitor, waitForChange } = createMonitor();

    // First change
    const first = waitForChange();
    monitor.write(encode("first"));
    await first;

    // Second change
    const second = waitForChange();
    monitor.write(encode("\r\nsecond"));
    const { snapshot, previous } = await second;

    expect(previous).toBeDefined();
    expect(richTextToPlainText(previous?.lines[0] as RichText)).toContain(
      "first",
    );
    expect(richTextToPlainText(snapshot.lines[1] as RichText)).toContain(
      "second",
    );

    monitor.dispose();
  });

  test("a throwing callback does not cause unhandled rejection", async () => {
    const monitor = new VirtualTerminal({
      cols: 80,
      rows: 24,
      scrollback: 0,
      debounceMs: 50,
      onChange() {
        throw new Error("boom");
      },
    });

    monitor.write(encode("data"));
    await monitor.flush();

    // If we reach here without unhandled rejection, the test passes.
    monitor.dispose();
  });

  test("write after dispose is a no-op", async () => {
    const { monitor, changes } = createMonitor();

    // Trigger initial change so we know things work
    monitor.write(encode("before"));
    await monitor.flush();
    expect(changes).toHaveLength(1);

    monitor.dispose();

    // Write after dispose should be silently ignored
    monitor.write(encode("after"));
    await Bun.sleep(80);
    expect(changes).toHaveLength(1);
  });

  test("flush after dispose is a no-op", async () => {
    const { monitor } = createMonitor({ debounceMs: 5000 });

    monitor.write(encode("data"));
    monitor.dispose();

    // flush after dispose should resolve without error
    await monitor.flush();
  });

  test("fires onChange at max interval under continuous writes", async () => {
    const { monitor, changes } = createMonitor({
      debounceMs: 5000,
      maxIntervalMs: 100,
    });

    // Write continuously — debounce (5s) will never fire, but
    // maxInterval (100ms) should trigger onChange.
    let char = 0;
    const interval = setInterval(() => {
      monitor.write(encode(String(char++ % 10)));
    }, 10);

    await Bun.sleep(180);
    clearInterval(interval);

    expect(changes.length).toBeGreaterThanOrEqual(1);

    monitor.dispose();
  });
});
