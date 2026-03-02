import { describe, expect, test } from "bun:test";
import { SequentialQueue } from "./async.ts";

describe("SequentialQueue", () => {
  test("executes tasks sequentially", async () => {
    const order: number[] = [];
    const queue = new SequentialQueue();

    queue.enqueue(async () => {
      await Bun.sleep(20);
      order.push(1);
    });
    queue.enqueue(async () => {
      order.push(2);
    });
    queue.enqueue(async () => {
      await Bun.sleep(10);
      order.push(3);
    });

    await queue.drain();
    expect(order).toEqual([1, 2, 3]);
  });

  test("drain resolves immediately when queue is empty", async () => {
    const queue = new SequentialQueue();
    await queue.drain();
  });

  test("error in a task does not prevent subsequent tasks", async () => {
    const errors: unknown[] = [];
    const results: number[] = [];
    const queue = new SequentialQueue({ onError: (e) => errors.push(e) });

    queue.enqueue(async () => {
      results.push(1);
    });
    queue.enqueue(async () => {
      throw new Error("boom");
    });
    queue.enqueue(async () => {
      results.push(3);
    });

    await queue.drain();
    expect(results).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  test("enqueue after drain starts a new sequence", async () => {
    const order: number[] = [];
    const queue = new SequentialQueue();

    queue.enqueue(async () => {
      order.push(1);
    });
    await queue.drain();

    queue.enqueue(async () => {
      order.push(2);
    });
    await queue.drain();

    expect(order).toEqual([1, 2]);
  });
});
