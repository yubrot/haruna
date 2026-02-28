/**
 * Attacher — wires scenes and channels onto a {@link Gateway} based on
 * {@link Config}, and manages hot-reload when the config or scene files change.
 *
 * @module
 */

import { type ChannelConfig, loadChannels } from "./channel/loader.ts";
import type { Config, ResolvedSceneEntries } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import type { Scene, SceneConfig } from "./scene/interface.ts";
import { loadScenes } from "./scene/loader.ts";
import { computeChecksum, FileWatch } from "./util/file.ts";

/** Options for creating an {@link Attacher}. */
export interface AttachOptions {
  /** The current haruna configuration. */
  config: Config;
  /** Working directory for scene resolution. */
  cwd: string;
  /** Configuration passed to scene factories during initialization. */
  sceneConfig: SceneConfig;
  /** Configuration passed to channel constructors during initialization. */
  channelConfig: ChannelConfig;
}

/**
 * Attach scenes and channels to a {@link Gateway} based on configuration.
 *
 * Handles scene loading, channel construction and startup, and file
 * watching for hot-reload. Uses {@link FileWatch} to monitor the config
 * file and dynamically loaded scene files. On any change the entire config
 * is re-loaded and diffs are applied.
 *
 * Call {@link start} once after construction, and {@link stop} when the
 * session ends.
 */
export class Attacher {
  private readonly gateway: Gateway;
  private readonly options: AttachOptions;
  private readonly fileWatch: FileWatch;
  private config: Config | null = null;
  private reloading = false;
  private scenesCache: [key: string, scenes: Scene[]] | null = null;

  constructor(gateway: Gateway, options: AttachOptions) {
    this.gateway = gateway;
    this.options = options;
    this.fileWatch = new FileWatch(() => {
      void this.reload();
    });
  }

  /**
   * Load scenes, build and start channels, and begin watching files
   * for changes (config file when a config path is present, plus
   * dynamically loaded scene files).
   */
  async start(): Promise<void> {
    await this.apply(this.options.config);
  }

  /**
   * Stop all channels attached to the gateway and close all file watchers.
   */
  async stop(): Promise<void> {
    this.fileWatch.close();
    await this.gateway.replaceChannels([]);
  }

  /**
   * Reload the config from disk and apply diffs.
   *
   * Guards against concurrent reloads. Changes that arrive while a
   * reload is already in flight are silently dropped.
   *
   * TODO: Track a `pendingReload` flag so that changes during an
   * in-flight reload are re-applied once the current cycle finishes.
   */
  private async reload(): Promise<void> {
    if (this.reloading) return;
    this.reloading = true;

    try {
      await this.apply(await this.options.config.reload());
    } catch (e) {
      console.error(
        `[haruna] config reload failed: ${e instanceof Error ? e.message : e}`,
      );
    } finally {
      this.reloading = false;
    }
  }

  /**
   * Apply a configuration, diffing against the previous one.
   *
   * Scenes are reloaded only when the cache key changes. Channels are
   * rebuilt only when their serialized config differs.
   */
  private async apply(newConfig: Config): Promise<void> {
    const { cwd, sceneConfig, channelConfig } = this.options;
    const fileWatchTargets: string[] = [];

    // Scenes
    const resolved = await newConfig.resolveSceneEntries(cwd);
    const sceneFilePaths = [...resolved.files.keys()];
    const cacheKey = await computeSceneCacheKey(resolved);

    if (this.scenesCache?.[0] !== cacheKey) {
      const scenes = await loadScenes(resolved, sceneConfig);
      this.gateway.replaceScenes(scenes);
      this.scenesCache = [cacheKey, scenes];
    }

    // Channels
    if (
      this.config === null ||
      JSON.stringify(newConfig.channels) !==
        JSON.stringify(this.config.channels)
    ) {
      const newChannels = loadChannels(newConfig.channels, channelConfig);
      await this.gateway.replaceChannels(newChannels);
    }

    // File watchers
    if (newConfig.path) fileWatchTargets.push(newConfig.path);
    fileWatchTargets.push(...sceneFilePaths);
    this.fileWatch.update(fileWatchTargets);

    this.config = newConfig;
  }
}

/**
 * Compute a cache key that covers builtin names, file contents,
 * and per-entry configuration properties.
 */
async function computeSceneCacheKey(
  resolved: ResolvedSceneEntries,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");

  // Builtins (names + props)
  for (const [name, props] of [...resolved.builtins.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
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
