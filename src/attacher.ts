/**
 * Attacher — wires scenes and channels onto a {@link Relay} based on
 * {@link Config}.
 *
 * @module
 */

import type { Channel } from "./channel/interface.ts";
import { type ChannelConfig, loadChannels } from "./channel/loader.ts";
import type { Config, ResolvedSceneEntries } from "./config.ts";
import type { Relay } from "./relay.ts";
import type { Scene, SceneConfig } from "./scene/interface.ts";
import { loadScenes } from "./scene/loader.ts";
import { computeChecksum } from "./util/file.ts";

/** Options for creating an {@link Attacher}. */
export interface AttachOptions {
  /** Configuration passed to scene factories during initialization. */
  sceneConfig: SceneConfig;
  /** Configuration passed to channel constructors during initialization. */
  channelConfig: ChannelConfig;
}

/**
 * Attach scenes and channels to a {@link Relay} based on configuration.
 *
 * Call {@link apply} with a {@link Config} to load scenes and channels,
 * and with `null` to detach everything.
 */
export class Attacher {
  private readonly relay: Relay;
  private readonly options: AttachOptions;
  private config: Config | null = null;
  private scenesCache: [key: string, scenes: Scene[]] | null = null;
  private managedChannels: Channel[] = [];

  constructor(relay: Relay, options: AttachOptions) {
    this.relay = relay;
    this.options = options;
  }

  /**
   * Apply a configuration, diffing against the previous one.
   *
   * Scenes are reloaded only when the cache key changes. Channels are
   * rebuilt only when their serialized config differs.
   *
   * Pass `null` to detach all scenes and channels (teardown).
   *
   * Not safe for concurrent calls — callers must serialize invocations.
   *
   * @param newConfig - Configuration to apply, or `null` to detach
   */
  async apply(newConfig: Config | null): Promise<void> {
    if (newConfig === null) {
      const toRemove = this.managedChannels;
      this.managedChannels = [];
      await this.relay.removeChannels(toRemove);
      this.relay.replaceScenes([]);
      this.scenesCache = null;
      this.config = null;
      return;
    }

    const { sceneConfig, channelConfig } = this.options;

    // Scenes
    const resolved = await newConfig.resolveSceneEntries();
    const cacheKey = await computeSceneCacheKey(resolved);

    if (this.scenesCache?.[0] !== cacheKey) {
      const scenes = await loadScenes(resolved, sceneConfig);
      this.relay.replaceScenes(scenes);
      this.scenesCache = [cacheKey, scenes];
    }

    // Channels
    if (
      this.config === null ||
      JSON.stringify(newConfig.channels) !== JSON.stringify(this.config.channels)
    ) {
      const oldManaged = this.managedChannels;
      this.managedChannels = [];
      await this.relay.removeChannels(oldManaged);

      const newChannels = loadChannels(newConfig.channels, channelConfig);
      await this.relay.addChannels(newChannels);
      this.managedChannels = newChannels;
    }

    this.config = newConfig;
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
