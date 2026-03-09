/**
 * Attacher — wires scenes and channels onto a {@link Session} based on
 * {@link Config}.
 *
 * @module
 */

import { type ChannelConfig, loadChannels } from "./channel/loader.ts";
import type { Config, ResolvedSceneEntries } from "./config.ts";
import type { Scene, SceneConfig } from "./scene/interface.ts";
import { loadScenes } from "./scene/loader.ts";
import type { Session } from "./session.ts";
import { computeChecksum } from "./util/file.ts";

/** Options for creating an {@link Attacher}. */
export interface AttachOptions {
  /** Configuration passed to scene factories during initialization. */
  sceneConfig: SceneConfig;
  /** Configuration passed to channel constructors during initialization. */
  channelConfig: ChannelConfig;
}

/**
 * Attach scenes and channels to a {@link Session} based on configuration.
 *
 * Call {@link apply} with a {@link Config} to load scenes and channels,
 * and with `null` to detach everything.
 */
export class Attacher {
  private readonly session: Session;
  private readonly options: AttachOptions;
  private config: Config | null = null;
  private scenesCache: [key: string, scenes: Scene[]] | null = null;

  constructor(session: Session, options: AttachOptions) {
    this.session = session;
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
      await this.session.replaceChannels([]);
      this.session.replaceScenes();
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
      this.session.replaceScenes(scenes);
      this.scenesCache = [cacheKey, scenes];
    }

    // Channels
    if (
      this.config === null ||
      JSON.stringify(newConfig.channels) !== JSON.stringify(this.config.channels)
    ) {
      const newChannels = loadChannels(newConfig.channels, channelConfig);
      await this.session.replaceChannels(newChannels);
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
