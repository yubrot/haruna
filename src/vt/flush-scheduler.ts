/**
 * Dual-timer flush scheduling: debounce + max interval.
 *
 * @module
 */

/** Default debounce delay in milliseconds. */
const DEFAULT_DEBOUNCE_MS = 100;

/** Default maximum interval between flushes in milliseconds. */
const DEFAULT_MAX_INTERVAL_MS = 300;

/** Options for creating a FlushScheduler. */
export interface FlushSchedulerOptions {
  /** Debounce delay in milliseconds. Defaults to 100ms. */
  debounceMs?: number;
  /** Maximum interval between flushes in milliseconds. Defaults to 300ms. */
  maxIntervalMs?: number;
  /** Callback invoked on each flush. */
  onFlush?: () => void;
}

/**
 * Schedules flush callbacks using debounce and max-interval timers.
 *
 * Call {@link notify} each time new data arrives. A flush fires when either:
 * 1. No notifications arrive for the debounce period (quiet settle), or
 * 2. The max interval elapses since the first notification after the last
 *    flush (guaranteed progress under continuous output).
 *
 * Whichever timer fires first triggers the flush and clears the other.
 */
export class FlushScheduler {
  private debounceMs: number;
  private maxIntervalMs: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private onFlush?: () => void;
  private disposed = false;

  /**
   * Create a new FlushScheduler.
   *
   * @param options - Configuration options
   */
  constructor(options?: FlushSchedulerOptions) {
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxIntervalMs = options?.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
    this.onFlush = options?.onFlush;
  }

  /** Signal that new data has arrived. */
  notify(): void {
    if (this.disposed) return;

    // Reset debounce timer
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.fireCallbacks();
    }, this.debounceMs);

    // Start interval timer on the first notify after a flush (or on first-ever notify)
    if (this.intervalTimer === null) {
      this.intervalTimer = setTimeout(() => {
        this.fireCallbacks();
      }, this.maxIntervalMs);
    }
  }

  /** Immediately fire pending flush callbacks. No-op if no timer is active. */
  flush(): void {
    if (this.debounceTimer !== null || this.intervalTimer !== null) {
      this.fireCallbacks();
    }
  }

  /** Release resources and prevent further callbacks. */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private fireCallbacks(): void {
    this.clearTimers();
    try {
      this.onFlush?.();
    } catch {
      // Prevent a failing callback from causing unhandled rejection.
    }
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.intervalTimer !== null) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}
