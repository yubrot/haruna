/**
 * Gateway — processes VT snapshots through scene recognition and
 * propagates output to channels.
 *
 * @module
 */

import type { Channel } from "./channel/interface.ts";
import { CompositeScene } from "./scene/builtin/composite.ts";
import type { Scene, SceneEvent, SceneInput } from "./scene/interface.ts";
import type { Snapshot } from "./vt/snapshot.ts";

/**
 * Snapshot processing and channel propagation gateway.
 *
 * Combines {@link CompositeScene} with a set of {@link Channel}s.
 * Each call to {@link Gateway.update | update} feeds a snapshot through the scene engine
 * and delivers the resulting output batch to all channels.
 */
export class Gateway {
  private composite?: CompositeScene;
  private channels: Channel[] = [];
  private lastSnapshot: Snapshot | null = null;
  private readonly write: ((bytes: string) => void) | null;

  /**
   * Create a new Gateway.
   *
   * @param options - Optional write callback for PTY injection
   */
  constructor(options?: { write?: (bytes: string) => void }) {
    this.write = options?.write ?? null;
  }

  /**
   * Process a VT snapshot through the scene engine and deliver the
   * output batch to all channels.
   *
   * @param snapshot - The snapshot to classify and propagate
   */
  update(snapshot: Snapshot): void {
    this.lastSnapshot = snapshot;
    const prevState = this.composite?.state ?? null;
    const events = this.composite?.process(snapshot).events ?? [];
    const newState = this.composite?.state ?? null;

    if (newState !== prevState) {
      events.push({ type: "scene_state_changed", state: newState });
    }
    this.broadcast(snapshot, events);
  }

  /**
   * Replace all scenes with a new set.
   *
   * Creates a fresh {@link CompositeScene}, discarding cached state and
   * continuation context.
   *
   * @param scenes - The new scene definitions
   */
  replaceScenes(scenes?: Scene[]): void {
    const prevState = this.composite?.state ?? null;
    this.composite = scenes?.length ? new CompositeScene(scenes) : undefined;

    // Notify channels if the active scene was cleared
    if (prevState !== null && this.lastSnapshot) {
      this.broadcast(this.lastSnapshot, [
        { type: "scene_state_changed", state: null },
      ]);
    }
  }

  /**
   * Replace all channels with a new set.
   *
   * Stops the old channels first to release resources (e.g. bound ports),
   * then starts the new channels with a scene-aware `send` callback
   * when a `write` function was given at construction.
   *
   * @param channels - The new channels
   */
  async replaceChannels(channels: Channel[]): Promise<void> {
    // TODO: How to handle concurrent `replaceChannels` calls?
    const old = this.channels;
    this.channels = [];
    await Promise.all(old.map((ch) => ch.stop().catch(() => {})));

    const send = (input: SceneInput) => this.send(input);
    const started: Channel[] = [];
    for (const ch of channels) {
      try {
        await ch.start(send);
        started.push(ch);
      } catch (e) {
        // Roll back already-started channels
        await Promise.all(started.map((s) => s.stop().catch(() => {})));
        throw e;
      }
    }
    this.channels = started;
  }

  /** Deliver a frame to all channels, isolating per-channel failures. */
  private broadcast(snapshot: Snapshot, events: SceneEvent[]): void {
    const frame = { snapshot, events };
    for (const ch of this.channels) {
      try {
        ch.receive(frame);
      } catch (e) {
        console.error(
          `[haruna][${ch.name}] receive failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  /**
   * Translate structured input through the active scene and write to the PTY.
   *
   * The active scene's `send` method is tried first. If it returns a string,
   * that value is written verbatim. Otherwise, `TextSceneInput` falls back to
   * `content + "\n"`. `SelectSceneInput` with no scene handler is silently ignored.
   */
  private send(input: SceneInput): void {
    if (!this.write) return;
    const mapped = this.composite?.encodeInput(input) ?? null;
    if (mapped !== null) {
      this.write(mapped);
    } else if (input.type === "text") {
      this.write(`${input.content}\r`);
    }
  }
}
