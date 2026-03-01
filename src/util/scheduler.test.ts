import { afterEach, describe, expect, test } from "bun:test";
import { Scheduler } from "./scheduler.ts";

describe("Scheduler", () => {
  let scheduler: Scheduler;

  afterEach(() => {
    scheduler?.dispose();
  });

  describe("debounce-only", () => {
    test("fires callback after debounce period", async () => {
      let flushed = false;
      scheduler = new Scheduler({
        debounceMs: 50,
        callback: () => {
          flushed = true;
        },
      });

      scheduler.schedule();
      expect(flushed).toBe(false);

      await Bun.sleep(80);
      expect(flushed).toBe(true);
    });

    test("resets debounce timer on consecutive schedule calls", async () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 50,
        callback: () => {
          count++;
        },
      });

      scheduler.schedule();
      await Bun.sleep(30);
      scheduler.schedule(); // reset
      await Bun.sleep(30);
      expect(count).toBe(0);

      await Bun.sleep(40);
      expect(count).toBe(1);
    });

    test("does not fire after dispose", async () => {
      let flushed = false;
      scheduler = new Scheduler({
        debounceMs: 50,
        callback: () => {
          flushed = true;
        },
      });

      scheduler.schedule();
      scheduler.dispose();

      await Bun.sleep(80);
      expect(flushed).toBe(false);
    });

    test("flush fires callback immediately", () => {
      let flushed = false;
      scheduler = new Scheduler({
        debounceMs: 5000,
        callback: () => {
          flushed = true;
        },
      });

      scheduler.schedule();
      expect(flushed).toBe(false);

      scheduler.flush();
      expect(flushed).toBe(true);
    });

    test("flush is no-op when nothing is pending", () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 50,
        callback: () => {
          count++;
        },
      });

      scheduler.flush();
      expect(count).toBe(0);
    });

    test("flush clears the timer so it does not fire again", async () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 50,
        callback: () => {
          count++;
        },
      });

      scheduler.schedule();
      scheduler.flush();
      expect(count).toBe(1);

      await Bun.sleep(80);
      expect(count).toBe(1);
    });

    test("schedule after flush starts a new debounce cycle", async () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 50,
        callback: () => {
          count++;
        },
      });

      scheduler.schedule();
      scheduler.flush();
      expect(count).toBe(1);

      scheduler.schedule();
      await Bun.sleep(80);
      expect(count).toBe(2);
    });

    test("callback error does not break the scheduler", () => {
      let callCount = 0;
      scheduler = new Scheduler({
        debounceMs: 50,
        callback: () => {
          callCount++;
          if (callCount === 1) throw new Error("boom");
        },
      });

      scheduler.schedule();
      scheduler.flush();
      expect(callCount).toBe(1);

      // Should still work after error
      scheduler.schedule();
      scheduler.flush();
      expect(callCount).toBe(2);
    });
  });

  describe("debounce + maxInterval", () => {
    test("fires at maxInterval under continuous scheduling", async () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 50,
        maxIntervalMs: 120,
        callback: () => {
          count++;
        },
      });

      const interval = setInterval(() => scheduler.schedule(), 20);

      await Bun.sleep(200);
      clearInterval(interval);

      expect(count).toBeGreaterThanOrEqual(1);
    });

    test("maxInterval resets after firing", async () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 5000,
        maxIntervalMs: 80,
        callback: () => {
          count++;
        },
      });

      const interval = setInterval(() => scheduler.schedule(), 10);

      await Bun.sleep(100);
      expect(count).toBe(1);

      await Bun.sleep(100);
      expect(count).toBe(2);

      clearInterval(interval);
    });

    test("debounce firing clears the maxInterval timer", async () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 50,
        maxIntervalMs: 200,
        callback: () => {
          count++;
        },
      });

      scheduler.schedule();
      await Bun.sleep(80);
      expect(count).toBe(1);

      await Bun.sleep(200);
      expect(count).toBe(1);
    });
  });

  describe("debounce + minInterval", () => {
    test("minInterval delays fire after debounce settles", async () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 30,
        minIntervalMs: 200,
        callback: () => {
          count++;
        },
      });

      // First fire: debounce settles at ~30ms, no prior call so minInterval is satisfied
      scheduler.schedule();
      await Bun.sleep(60);
      expect(count).toBe(1);

      // Second burst immediately after: debounce settles at ~30ms,
      // but minInterval (200ms since last fire) is not yet satisfied
      scheduler.schedule();
      await Bun.sleep(60);
      expect(count).toBe(1); // still waiting for minInterval

      await Bun.sleep(180);
      expect(count).toBe(2); // minInterval elapsed, fires
    });

    test("re-schedule from callback respects debounce", async () => {
      const timestamps: number[] = [];
      scheduler = new Scheduler({
        debounceMs: 40,
        minIntervalMs: 0,
        callback: () => {
          timestamps.push(Date.now());
          if (timestamps.length < 3) scheduler.schedule();
        },
      });

      scheduler.schedule();
      await Bun.sleep(250);
      expect(timestamps).toHaveLength(3);
      for (let i = 1; i < timestamps.length; i++) {
        const delta = (timestamps[i] as number) - (timestamps[i - 1] as number);
        expect(delta).toBeGreaterThanOrEqual(30); // each re-schedule goes through debounce
      }
    });

    test("flush bypasses debounce and minInterval", () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 5000,
        minIntervalMs: 5000,
        callback: () => {
          count++;
        },
      });

      scheduler.schedule();
      scheduler.flush();
      expect(count).toBe(1);

      // Immediate re-flush bypasses minInterval too
      scheduler.schedule();
      scheduler.flush();
      expect(count).toBe(2);
    });
  });

  describe("debounce + minInterval + maxInterval", () => {
    test("maxInterval forces fire even when debounce keeps resetting", async () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 80,
        minIntervalMs: 0,
        maxIntervalMs: 120,
        callback: () => {
          count++;
        },
      });

      // Continuously reset debounce — maxInterval should still fire
      const interval = setInterval(() => scheduler.schedule(), 20);

      await Bun.sleep(200);
      clearInterval(interval);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    test("minInterval delays fire triggered by maxInterval", async () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 5000,
        minIntervalMs: 200,
        maxIntervalMs: 50,
        callback: () => {
          count++;
        },
      });

      // First burst: maxInterval fires at ~50ms, minInterval satisfied (no prior call)
      scheduler.schedule();
      await Bun.sleep(80);
      expect(count).toBe(1);

      // Second burst immediately: maxInterval fires at ~50ms,
      // but minInterval (200ms) blocks it
      scheduler.schedule();
      await Bun.sleep(80);
      expect(count).toBe(1); // blocked by minInterval

      await Bun.sleep(180);
      expect(count).toBe(2); // minInterval elapsed
    });

    test("dispose cancels all timers", async () => {
      let count = 0;
      scheduler = new Scheduler({
        debounceMs: 50,
        minIntervalMs: 50,
        maxIntervalMs: 100,
        callback: () => {
          count++;
        },
      });

      scheduler.schedule();
      scheduler.dispose();
      await Bun.sleep(150);
      expect(count).toBe(0);
    });
  });
});
