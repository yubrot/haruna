/**
 * Unified timer scheduler with debounce, rate-limiting, and max-interval.
 *
 * Provides three orthogonal timing knobs that can be combined freely:
 * - **debounce**: quiet-settle delay, reset on each {@link Scheduler.schedule} call
 * - **maxInterval**: guaranteed progress timer since first schedule in a burst
 * - **minInterval**: minimum gap between consecutive callback executions
 *
 * @module
 */

/** Options for creating a {@link Scheduler}. */
export interface SchedulerOptions {
  /** Quiet-settle delay (ms); resets on each {@link Scheduler.schedule} call. */
  debounceMs?: number;
  /** Minimum gap (ms) between consecutive callback executions (rate-limit). */
  minIntervalMs?: number;
  /** Maximum wait (ms) since first schedule in a burst (guaranteed progress). */
  maxIntervalMs?: number;
  /** Fired when the scheduler triggers. */
  callback: () => void;
}

/**
 * Timer scheduler combining debounce, max-interval, and rate-limiting.
 *
 * Call {@link schedule} when new work arrives. The callback fires once the
 * timing constraints are satisfied. To process further work, call
 * {@link schedule} again from the callback or after async work completes.
 */
export class Scheduler {
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly callback: () => void;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxIntervalTimer: ReturnType<typeof setTimeout> | null = null;
  private minIntervalTimer: ReturnType<typeof setTimeout> | null = null;
  /** Deferred fire for the no-debounce, no-maxInterval path. */
  private immediateTimer: ReturnType<typeof setTimeout> | null = null;

  private pending = false;
  private lastCallTime = 0;
  private disposed = false;

  /**
   * @param options - Timing configuration and callback
   */
  constructor(options: SchedulerOptions) {
    this.debounceMs = options.debounceMs ?? 0;
    this.maxIntervalMs = options.maxIntervalMs ?? 0;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.callback = options.callback;
  }

  /**
   * Whether there is any pending work or not.
   */
  get isActive(): boolean {
    return this.pending;
  }

  /**
   * Signal that new work is available.
   *
   * Starts or resets the debounce timer and, on the first call in a burst,
   * starts the max-interval timer.
   */
  schedule(): void {
    if (this.disposed) return;
    this.pending = true;

    // Reset debounce timer
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.debounceMs > 0) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.tryFire();
      }, this.debounceMs);
    }

    // Start max-interval timer on first schedule in a burst
    if (this.maxIntervalMs > 0 && this.maxIntervalTimer === null) {
      this.maxIntervalTimer = setTimeout(() => {
        this.maxIntervalTimer = null;
        this.tryFire();
      }, this.maxIntervalMs);
    }

    // No debounce and no max-interval: use a deferred trigger so
    // multiple synchronous schedule() calls coalesce into one fire.
    // When minIntervalTimer is already running it will call tryFire()
    // on expiry, so we skip the immediate trigger to avoid double-fire.
    if (
      this.debounceMs === 0 &&
      this.maxIntervalMs === 0 &&
      this.immediateTimer === null &&
      this.minIntervalTimer === null
    ) {
      this.immediateTimer = setTimeout(() => {
        this.immediateTimer = null;
        this.tryFire();
      }, 0);
    }
  }

  /**
   * Fire the pending callback immediately, bypassing all timing constraints.
   *
   * No-op if nothing is pending. The callback runs synchronously during
   * this call.
   */
  flush(): void {
    if (this.disposed) return;
    if (!this.pending) return;
    this.fire();
  }

  /** Release all resources and prevent further callbacks. */
  dispose(): void {
    this.disposed = true;
    this.pending = false;
    this.clearAllTimers();
  }

  private tryFire(): void {
    if (this.disposed || !this.pending) return;

    // Enforce minInterval
    if (this.minIntervalMs > 0) {
      const elapsed = Date.now() - this.lastCallTime;
      if (elapsed < this.minIntervalMs) {
        if (this.minIntervalTimer === null) {
          const delay = this.minIntervalMs - elapsed;
          this.minIntervalTimer = setTimeout(() => {
            this.minIntervalTimer = null;
            this.tryFire();
          }, delay);
        }
        return;
      }
    }

    this.fire();
  }

  private fire(): void {
    this.lastCallTime = Date.now();
    this.pending = false;
    this.clearAllTimers();

    try {
      this.callback();
    } catch {
      // Prevent a failing callback from causing unhandled rejection.
    }
  }

  private clearAllTimers(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxIntervalTimer !== null) {
      clearTimeout(this.maxIntervalTimer);
      this.maxIntervalTimer = null;
    }
    if (this.immediateTimer !== null) {
      clearTimeout(this.immediateTimer);
      this.immediateTimer = null;
    }
    if (this.minIntervalTimer !== null) {
      clearTimeout(this.minIntervalTimer);
      this.minIntervalTimer = null;
    }
  }
}
