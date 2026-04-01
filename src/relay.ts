/**
 * Relay — bidirectional relay between VT snapshots and channels.
 *
 * Processes snapshots through scene recognition (output path) and
 * routes channel input back through scenes to the PTY (input path).
 * {@link RelayConfigurator} applies {@link Config} diffs to a Relay.
 *
 * @module
 */

import type { Channel } from "./channel/interface.ts";
import { type ChannelConfig, loadChannels } from "./channel/loader.ts";
import type { Config, ResolvedSceneEntries } from "./config.ts";
import { CompositeScene } from "./scene/builtin/composite.ts";
import type { InputAction, Scene, SceneConfig, SceneEvent, SceneInput } from "./scene/interface.ts";
import { loadScenes } from "./scene/loader.ts";
import { SequentialQueue } from "./util/async.ts";
import { computeChecksum } from "./util/file.ts";
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
  private channels: Set<Channel> = new Set();
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

    let events: SceneEvent[];
    try {
      events = this.composite?.process(snapshot).events ?? [];
    } catch (e) {
      console.error(`[haruna] scene processing failed: ${e instanceof Error ? e.message : e}`);
      events = [];
    }

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
   * @param channels - Channels to add
   */
  async addChannels(channels: Channel[]): Promise<void> {
    const send = (input: SceneInput) => this.send(input);
    for (const ch of channels) {
      if (this.channels.has(ch)) continue;
      try {
        await ch.start(send);
        this.channels.add(ch);
      } catch (e) {
        console.error(
          `[haruna][${ch.name}] failed to start: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  /**
   * Remove channels from the relay.
   *
   * @param channels - Channels to remove
   */
  async removeChannels(channels: Channel[]): Promise<void> {
    const removed: Channel[] = [];
    for (const ch of channels) {
      if (this.channels.delete(ch)) removed.push(ch);
    }
    await Promise.all(removed.map((ch) => stopChannel(ch)));
  }

  /**
   * Stop all channels and clear all scenes.
   */
  async dispose(): Promise<void> {
    const channels = [...this.channels];
    this.channels.clear();
    await Promise.all(channels.map((ch) => stopChannel(ch)));
    this.composite = undefined;
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
      let mapped: InputAction[] | InputAction | null;
      try {
        mapped = this.composite?.encodeInput(input) ?? null;
      } catch (e) {
        console.error(`[haruna] scene encodeInput failed: ${e instanceof Error ? e.message : e}`);
        return;
      }
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

/** Options controlling how config is applied to a relay. */
export interface RelayConfiguratorOptions {
  /** Operating mode forwarded to scene/channel factories. */
  mode: "exec" | "replay";
  /** The command being executed. */
  command: string[];
}

/**
 * Applies configuration (scenes and channels) to a {@link Relay}.
 *
 * Scenes are reloaded only when the cache key changes. Channels are
 * rebuilt only when their serialized config differs.
 *
 * Not safe for concurrent calls — callers must serialize invocations.
 */
export class RelayConfigurator {
  private readonly relay: Relay;
  private readonly options: RelayConfiguratorOptions;
  private scenesCache: [key: string, scenes: Scene[]] | null = null;
  private managedChannels: Channel[] = [];
  private appliedConfig: Config | null = null;

  constructor(relay: Relay, options: RelayConfiguratorOptions) {
    this.relay = relay;
    this.options = options;
  }

  /**
   * Apply configuration on the relay.
   *
   * @param config - Configuration to apply
   */
  async apply(config: Config): Promise<void> {
    const runtimeInfo = { _mode: this.options.mode, _command: this.options.command };
    const sceneConfig: SceneConfig = { ...runtimeInfo };
    const channelConfig: ChannelConfig = { ...runtimeInfo };

    // Scenes
    const resolved = await config.resolveSceneEntries();
    const cacheKey = await computeSceneCacheKey(resolved);

    if (this.scenesCache?.[0] !== cacheKey) {
      const scenes = await loadScenes(resolved, sceneConfig);
      this.relay.replaceScenes(scenes);
      this.scenesCache = [cacheKey, scenes];
    }

    // Channels
    if (
      this.appliedConfig === null ||
      JSON.stringify(config.channels) !== JSON.stringify(this.appliedConfig.channels)
    ) {
      const oldManaged = this.managedChannels;
      this.managedChannels = [];
      await this.relay.removeChannels(oldManaged);

      const newChannels = loadChannels(config.channels, channelConfig);
      await this.relay.addChannels(newChannels);
      this.managedChannels = newChannels;
    }

    this.appliedConfig = config;
  }
}

/**
 * Compute a cache key that covers builtin names, file contents,
 * and per-entry configuration properties.
 */
async function computeSceneCacheKey(resolved: ResolvedSceneEntries): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");

  // Builtins (names + props)
  for (const [name, props] of [...resolved.builtins.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    hasher.update(name);
    if (Object.keys(props).length > 0) hasher.update(JSON.stringify(props));
  }

  // File contents + props
  const filePaths = [...resolved.files.keys()].sort();
  const fileChecksum = await computeChecksum(filePaths);
  hasher.update(fileChecksum);
  for (const [path, props] of [...resolved.files.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (Object.keys(props).length > 0) {
      hasher.update(path);
      hasher.update(JSON.stringify(props));
    }
  }

  return hasher.digest("hex");
}

async function stopChannel(ch: Channel): Promise<void> {
  try {
    await ch.stop();
  } catch (e) {
    console.error(`[haruna][${ch.name}] failed to stop: ${e instanceof Error ? e.message : e}`);
  }
}
