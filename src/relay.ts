/**
 * Relay — bidirectional relay between VT snapshots and channels.
 *
 * Processes snapshots through scene recognition (output path) and
 * routes channel input back through scenes to the PTY (input path).
 *
 * @module
 */

import type { Channel } from "./channel/interface.ts";
import { CompositeScene } from "./scene/builtin/composite.ts";
import type { InputAction, Scene, SceneEvent, SceneInput } from "./scene/interface.ts";
import { SequentialQueue } from "./util/async.ts";
import type { Snapshot } from "./vt/snapshot.ts";

/**
 * Bidirectional relay between VT snapshots and channels.
 *
 * Combines {@link CompositeScene} with a set of {@link Channel}s.
 * Each call to {@link Relay.update | update} feeds a snapshot through the scene engine
 * and delivers the resulting output batch to all channels.
 */
export class Relay {
  private composite?: CompositeScene;
  private channels: Channel[] = [];
  private lastSnapshot: Snapshot | null = null;
  private prevIdle = false;
  private readonly write: ((bytes: string) => void) | null;
  private readonly sendQueue: SequentialQueue;

  /**
   * Create a new Relay.
   *
   * @param options - Optional write callback for PTY injection
   */
  constructor(options?: { write?: (bytes: string) => void }) {
    this.write = options?.write ?? null;
    this.sendQueue = new SequentialQueue({
      onError: (e) => console.error(`[haruna] send failed: ${e instanceof Error ? e.message : e}`),
    });
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

    const currentIdle = this.composite?.isIdle ?? false;
    if (newState !== prevState) {
      const idle = !this.prevIdle && currentIdle ? true : undefined;
      events.push({ type: "scene_state_changed", state: newState, idle });
    }
    this.prevIdle = currentIdle;
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
  replaceScenes(scenes: Scene[]): void {
    const prevState = this.composite?.state ?? null;
    this.composite = scenes.length ? new CompositeScene(scenes) : undefined;
    this.prevIdle = false;

    // Notify channels if the active scene was cleared
    if (prevState !== null && this.lastSnapshot) {
      this.broadcast(this.lastSnapshot, [{ type: "scene_state_changed", state: null }]);
    }
  }

  /**
   * Add channels to the relay.
   *
   * Each channel is started with a scene-aware `send` callback.
   *
   * @param channels - Channels to add
   */
  async addChannels(channels: Channel[]): Promise<void> {
    const send = (input: SceneInput) => this.send(input);
    const started: Channel[] = [];
    for (const ch of channels) {
      try {
        await ch.start(send);
        started.push(ch);
      } catch (e) {
        await Promise.all(started.map((s) => s.stop().catch(() => {})));
        throw e;
      }
    }
    this.channels.push(...started);
  }

  /**
   * Remove channels from the relay.
   *
   * Each channel is stopped and removed from the internal list.
   * Channels not present in the relay are silently ignored.
   *
   * @param channels - Channels to remove
   */
  async removeChannels(channels: Channel[]): Promise<void> {
    const toRemove = new Set(channels);
    const removed: Channel[] = [];
    this.channels = this.channels.filter((ch) => {
      if (toRemove.has(ch)) {
        removed.push(ch);
        return false;
      }
      return true;
    });
    await Promise.all(removed.map((ch) => ch.stop().catch(() => {})));
  }

  /**
   * Wait for all pending input writes to complete.
   *
   * Exposed for testing; production code does not need to call this.
   */
  flush(): Promise<void> {
    return this.sendQueue.drain();
  }

  /** Deliver a frame to all channels, isolating per-channel failures. */
  private broadcast(snapshot: Snapshot, events: SceneEvent[]): void {
    const frame = { snapshot, events };
    for (const ch of this.channels) {
      try {
        ch.receive(frame);
      } catch (e) {
        console.error(`[haruna][${ch.name}] receive failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /**
   * Translate structured input through the active scene and write to the PTY.
   *
   * The active scene's `encodeInput` is tried first. If it returns action(s),
   * they are executed in order (strings are written, `{ sleep }` values are
   * awaited). Otherwise, `TextSceneInput` falls back to writing `content + CR`.
   * `SelectSceneInput` with no scene handler is silently ignored.
   *
   * Calls are serialized through a {@link SequentialQueue} so that concurrent
   * inputs do not interleave PTY writes.
   */
  private send(input: SceneInput): void {
    if (!this.write) return;
    this.sendQueue.enqueue(async () => {
      const mapped = this.composite?.encodeInput(input) ?? null;
      if (mapped !== null) {
        await this.executeActions(mapped);
      } else if (input.type === "text") {
        await this.executeActions(`${input.content}\r`);
      }
    });
  }

  /** Execute one or more {@link InputAction}s sequentially. */
  private async executeActions(actions: InputAction[] | InputAction): Promise<void> {
    if (!Array.isArray(actions)) actions = [actions];
    for (const action of actions) {
      if (typeof action === "string") {
        this.write?.(action);
      } else {
        await Bun.sleep(action.sleep);
      }
    }
  }
}
