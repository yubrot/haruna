import { describe, expect, test } from "bun:test";
import { FlushScheduler } from "./flush-scheduler.ts";

describe("FlushScheduler", () => {
  test("fires callback after debounce period", async () => {
    let flushed = false;
    const scheduler = new FlushScheduler({
      debounceMs: 50,
      maxIntervalMs: 5000,
      onFlush: () => {
        flushed = true;
      },
    });

    scheduler.notify();
    expect(flushed).toBe(false);

    await Bun.sleep(80);
    expect(flushed).toBe(true);

    scheduler.dispose();
  });

  test("resets debounce timer on consecutive notifications", async () => {
    let count = 0;
    const scheduler = new FlushScheduler({
      debounceMs: 50,
      maxIntervalMs: 5000,
      onFlush: () => {
        count++;
      },
    });

    scheduler.notify();
    await Bun.sleep(30);
    scheduler.notify(); // reset debounce timer
    await Bun.sleep(30);
    // 60ms total but only 30ms since last notify — should not have fired yet
    expect(count).toBe(0);

    await Bun.sleep(40);
    // now 70ms since last notify — should have fired once
    expect(count).toBe(1);

    scheduler.dispose();
  });

  test("does not fire after dispose", async () => {
    let flushed = false;
    const scheduler = new FlushScheduler({
      debounceMs: 50,
      maxIntervalMs: 5000,
      onFlush: () => {
        flushed = true;
      },
    });

    scheduler.notify();
    scheduler.dispose();

    await Bun.sleep(80);
    expect(flushed).toBe(false);
  });

  test("does not fire on notify after dispose", async () => {
    let flushed = false;
    const scheduler = new FlushScheduler({
      debounceMs: 50,
      maxIntervalMs: 5000,
      onFlush: () => {
        flushed = true;
      },
    });

    scheduler.dispose();
    scheduler.notify();

    await Bun.sleep(80);
    expect(flushed).toBe(false);
  });

  test("flush fires callback immediately", () => {
    let flushed = false;
    const scheduler = new FlushScheduler({
      debounceMs: 5000,
      maxIntervalMs: 10000,
      onFlush: () => {
        flushed = true;
      },
    });

    scheduler.notify();
    expect(flushed).toBe(false);

    scheduler.flush();
    expect(flushed).toBe(true);

    scheduler.dispose();
  });

  test("flush is no-op when no timer is pending", () => {
    let count = 0;
    const scheduler = new FlushScheduler({
      debounceMs: 50,
      maxIntervalMs: 5000,
      onFlush: () => {
        count++;
      },
    });

    scheduler.flush(); // no timer pending
    expect(count).toBe(0);

    scheduler.dispose();
  });

  test("flush clears the timer so it does not fire again", async () => {
    let count = 0;
    const scheduler = new FlushScheduler({
      debounceMs: 50,
      maxIntervalMs: 5000,
      onFlush: () => {
        count++;
      },
    });

    scheduler.notify();
    scheduler.flush();
    expect(count).toBe(1);

    await Bun.sleep(80);
    // should not fire again
    expect(count).toBe(1);

    scheduler.dispose();
  });

  test("notify after flush starts a new debounce cycle", async () => {
    let count = 0;
    const scheduler = new FlushScheduler({
      debounceMs: 50,
      maxIntervalMs: 5000,
      onFlush: () => {
        count++;
      },
    });

    scheduler.notify();
    scheduler.flush();
    expect(count).toBe(1);

    // New notify after flush should start a fresh cycle
    scheduler.notify();
    await Bun.sleep(80);
    expect(count).toBe(2);

    scheduler.dispose();
  });

  // --- max interval tests ---

  test("fires callback at max interval under continuous notifications", async () => {
    let count = 0;
    const scheduler = new FlushScheduler({
      debounceMs: 50,
      maxIntervalMs: 120,
      onFlush: () => {
        count++;
      },
    });

    // Notify every 20ms for 200ms — debounce (50ms) never settles,
    // but max interval (120ms) should fire at least once.
    const interval = setInterval(() => scheduler.notify(), 20);

    await Bun.sleep(200);
    clearInterval(interval);

    expect(count).toBeGreaterThanOrEqual(1);

    scheduler.dispose();
  });

  test("max interval resets after firing, starting a new cycle", async () => {
    let count = 0;
    const scheduler = new FlushScheduler({
      debounceMs: 5000,
      maxIntervalMs: 80,
      onFlush: () => {
        count++;
      },
    });

    // Continuous notifications — debounce never fires, only interval.
    const interval = setInterval(() => scheduler.notify(), 10);

    await Bun.sleep(100);
    expect(count).toBe(1); // first interval fire

    await Bun.sleep(100);
    expect(count).toBe(2); // second interval fire (new cycle)

    clearInterval(interval);
    scheduler.dispose();
  });

  test("debounce firing clears the interval timer", async () => {
    let count = 0;
    const scheduler = new FlushScheduler({
      debounceMs: 50,
      maxIntervalMs: 200,
      onFlush: () => {
        count++;
      },
    });

    scheduler.notify();
    // Wait for debounce to fire (50ms)
    await Bun.sleep(80);
    expect(count).toBe(1);

    // Wait past the original maxInterval time — should NOT fire again
    await Bun.sleep(200);
    expect(count).toBe(1);

    scheduler.dispose();
  });
});
