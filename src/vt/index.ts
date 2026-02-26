/**
 * Virtual terminal — snapshot-producing abstraction over a terminal emulator.
 *
 * @module
 */

import { Emulator } from "./emulator.ts";
import { FlushScheduler } from "./flush-scheduler.ts";
import type { Snapshot } from "./snapshot.ts";
import { snapshotsEqual } from "./snapshot.ts";

/** Options for creating a VirtualTerminal. */
export interface VirtualTerminalOptions {
  /** Terminal width in columns. */
  cols: number;
  /** Terminal height in rows. */
  rows: number;
  /** Number of scrollback lines to retain above the viewport. */
  scrollback: number;
  /** Debounce delay in milliseconds for flush scheduling. Defaults to 100ms. */
  debounceMs?: number;
  /** Maximum interval between flushes in milliseconds. Defaults to 300ms. */
  maxIntervalMs?: number;
  /**
   * Callback invoked when a meaningful change is detected.
   *
   * Fires only when text, cursor position, cursor visibility, or
   * dimensions have changed since the previous capture.
   *
   * @param snapshot - The new snapshot
   * @param previous - The previous snapshot, or undefined for the first capture
   */
  onChange?: (snapshot: Snapshot, previous: Snapshot | undefined) => void;
}

/**
 * Virtual terminal that produces {@link Snapshot}s from PTY output.
 *
 * Emits change events when the content or cursor state has
 * meaningfully changed.
 */
export class VirtualTerminal {
  private emulator: Emulator;
  private scheduler: FlushScheduler;
  private onChange?: (
    snapshot: Snapshot,
    previous: Snapshot | undefined,
  ) => void;
  private previousSnapshot: Snapshot | undefined;
  private runningCapture: Promise<void> | null = null;
  private captureNeeded = false;
  private disposed = false;

  /**
   * Create a new VirtualTerminal.
   *
   * @param options - Terminal dimensions, flush scheduling, and change callback
   */
  constructor(options: VirtualTerminalOptions) {
    this.onChange = options.onChange;
    this.emulator = new Emulator({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
    });
    this.scheduler = new FlushScheduler({
      debounceMs: options.debounceMs,
      maxIntervalMs: options.maxIntervalMs,
      onFlush: () => {
        this.captureNeeded = true;
        if (!this.runningCapture) {
          this.runningCapture = this.runCapture();
        }
      },
    });
  }

  /**
   * Feed PTY output data into the virtual terminal.
   *
   * Change callbacks will fire after the debounce period or
   * when the max interval is reached.
   *
   * @param data - Raw bytes from PTY output
   */
  write(data: Uint8Array): void {
    if (this.disposed) return;
    this.emulator.write(data);
    this.scheduler.notify();
  }

  /**
   * Resize the virtual terminal.
   *
   * Does not trigger change callbacks by itself. A subsequent {@link write}
   * is needed for the new dimensions to be detected via {@link onChange}.
   *
   * @param cols - New width in columns
   * @param rows - New height in rows
   */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.emulator.resize(cols, rows);
  }

  /** The snapshot from the most recent capture, or undefined before the first one. */
  get lastSnapshot(): Snapshot | undefined {
    return this.previousSnapshot;
  }

  /**
   * Take a snapshot of the current state immediately.
   *
   * Does not trigger change callbacks or update {@link lastSnapshot}.
   *
   * @returns The current snapshot
   */
  takeSnapshot(): Snapshot {
    return this.emulator.takeSnapshot();
  }

  /**
   * Process all pending writes and fire change callbacks immediately.
   *
   * Use before {@link dispose} to ensure the last change is processed.
   *
   * @returns A promise that resolves when the flush is complete
   */
  async flush(): Promise<void> {
    if (this.disposed) return;
    this.scheduler.flush();
    await this.runningCapture;
  }

  /** Release all resources. Further method calls are no-ops. */
  dispose(): void {
    this.disposed = true;
    this.scheduler.dispose();
    this.emulator.dispose();
  }

  private async runCapture(): Promise<void> {
    // Multiple scheduler fires during a single capture are collapsed:
    // the loop re-checks captureNeeded, so at most one extra capture runs.
    while (this.captureNeeded) {
      this.captureNeeded = false;

      try {
        await this.emulator.flush();

        const snapshot = this.emulator.takeSnapshot();
        const previous = this.previousSnapshot;
        this.previousSnapshot = snapshot;
        if (previous && snapshotsEqual(previous, snapshot)) continue;

        try {
          this.onChange?.(snapshot, previous);
        } catch {
          // Prevent a failing callback from causing unhandled rejection.
        }
      } catch {
        // Prevent unhandled promise rejection from xterm.js or callbacks.
      }
    }
    this.runningCapture = null;
  }
}
