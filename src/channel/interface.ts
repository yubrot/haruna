/**
 * Channel interface.
 *
 * @module
 */

import type { SceneEvent, SceneInput } from "../scene/interface.ts";
import type { Snapshot } from "../vt/snapshot.ts";

/** Lifecycle contract shared by all channel implementations. */
export interface Channel {
  /**
   * Start the channel (begin accepting connections / listening).
   *
   * @param send - Callback for sending structured input back to the terminal, or `null` when input injection is unavailable
   * @returns A promise that resolves when the channel is ready
   */
  start(send: SendSceneInput | null): Promise<void>;

  /**
   * Stop the channel and release resources.
   *
   * @returns A promise that resolves when the channel has fully stopped
   */
  stop(): Promise<void>;

  /**
   * Deliver a batch of output from a single snapshot change.
   *
   * @param frame - The frame to deliver
   */
  receive(frame: Frame): void;
}

/**
 * Callback for sending structured input back to the system
 * (e.g. inject text into the PTY).
 */
export type SendSceneInput = (input: SceneInput) => void;

/** A snapshot paired with scene events from a single screen change. */
export interface Frame {
  /** The current VT snapshot. */
  snapshot: Snapshot;
  /** Scene events emitted for this snapshot (empty when no scene matched). */
  events: SceneEvent[];
}
