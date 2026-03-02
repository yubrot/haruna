/**
 * Async utilities.
 *
 * @module
 */

/**
 * A queue that executes async tasks one at a time in the order they are
 * enqueued. Each task starts only after the previous one settles.
 *
 * Errors thrown by a task are reported to the optional `onError` callback
 * and do **not** prevent subsequent tasks from running.
 */
export class SequentialQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly onError: (error: unknown) => void;

  /**
   * @param options.onError - Called when an enqueued task rejects.
   *   Defaults to `console.error`.
   */
  constructor(options?: { onError?: (error: unknown) => void }) {
    this.onError = options?.onError ?? ((e) => console.error(e));
  }

  /**
   * Append a task to the queue. The task will execute after all previously
   * enqueued tasks have settled.
   *
   * @param task - An async function to execute
   */
  enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch(this.onError);
  }

  /**
   * Returns a promise that resolves when all currently enqueued tasks
   * have settled (the queue is empty).
   */
  drain(): Promise<void> {
    return this.tail;
  }
}
