/**
 * CompositeScene: orchestrates multiple scenes against VT snapshots.
 *
 * Implements the {@link Scene} interface itself, delegating to child scenes
 * in priority order with continuation and preemption semantics.
 *
 * @module
 */

import type { Snapshot } from "../../vt/snapshot.ts";
import type {
  Scene,
  SceneContinuation,
  SceneEvent,
  SceneInput,
} from "../interface.ts";

/**
 * A composite scene that delegates to child scenes in priority order.
 *
 * Tracks the currently active child scene and supports both firm and
 * tentative continuations. Tentative continuations allow preemption
 * by higher-priority scenes whose `detect()` succeeds.
 */
export class CompositeScene implements Scene {
  readonly priority: number;
  private scenes: Scene[];
  private activeScene: Scene | null = null;

  /**
   * Create a new CompositeScene.
   *
   * @param scenes - Child scene definitions. Sorted by priority (lower first).
   * @param options - Optional priority override
   */
  constructor(scenes: Scene[], options?: { priority?: number }) {
    this.priority = options?.priority ?? 0;
    this.scenes = [...scenes].sort((a, b) => a.priority - b.priority);
  }

  /** Active child scene's state, or `null` when no scene is active. */
  get state(): string | null {
    return this.activeScene?.state ?? null;
  }

  /**
   * Top-level orchestration for callers (Gateway, dump).
   *
   * Runs continuation + preemption if an active scene exists, then falls
   * through to clean detection. NOT part of the Scene interface.
   *
   * @param snapshot - The VT snapshot to classify
   * @returns Continuation result with events and firmness
   */
  process(snapshot: Snapshot): SceneContinuation {
    // Step 1: try continuation + preemption
    const continuation = this.continue(snapshot);
    if (continuation !== null) return continuation;

    // Step 2: clean detect (decisive match or no match)
    const detected = this.detect(snapshot);
    return { events: detected ?? [], firm: detected !== null };
  }

  /** Try all child scenes in priority order for fresh detection. */
  detect(snapshot: Snapshot): SceneEvent[] | null {
    for (const s of this.scenes) {
      const events = s.detect(snapshot);
      if (events !== null) {
        this.activeScene = s;
        return events;
      }
    }
    return null;
  }

  /** Continue with the active child, running preemption scan on tentative results. */
  continue(snapshot: Snapshot): SceneContinuation | null {
    if (!this.activeScene) return null;

    const result = this.activeScene.continue(snapshot);
    if (result === null) {
      // Continuation failed — clear active scene
      this.activeScene = null;
      return null;
    }

    if (result.firm) {
      return result;
    }

    // Tentative continuation — try preemption
    for (const s of this.scenes) {
      if (s === this.activeScene) continue;

      const events = s.detect(snapshot);
      if (events !== null) {
        this.activeScene = s;
        // Preemption is a decisive transition — no need to re-scan within
        // the same snapshot, so we mark it firm.
        return { events, firm: true };
      }
    }

    // No preemption — return tentative result
    return result;
  }

  /**
   * Delegate input to the active child scene.
   *
   * @param input - The structured input from a channel
   * @returns Raw bytes to write to the PTY, or `null` if no active scene handles it
   */
  encodeInput(input: SceneInput): string | null {
    return this.activeScene?.encodeInput?.(input) ?? null;
  }
}
