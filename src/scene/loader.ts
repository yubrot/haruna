/**
 * Scene loading — instantiates {@link Scene} objects from builtin
 * registry entries or file-based modules.
 *
 * @module
 */

import type { ResolvedSceneEntries } from "../config.ts";
import { builtinSceneRegistry } from "./builtin/registry.ts";
import {
  isScene,
  type Scene,
  type SceneConfig,
  type SceneFactory,
} from "./interface.ts";

/**
 * Load {@link Scene} instances from previously resolved entries.
 *
 * Iterates over builtin names and file paths, loading each via
 * {@link loadBuiltinScene} and {@link loadFileScene}. Per-entry
 * properties are merged into the {@link SceneConfig} passed to each
 * scene factory. Entries that fail to load are silently skipped
 * (errors are logged to stderr).
 *
 * @param resolved - Resolved scene entries from {@link Config.resolveSceneEntries}
 * @param config - Base configuration passed to scene factories
 * @returns Successfully loaded scene instances
 */
export async function loadScenes(
  resolved: ResolvedSceneEntries,
  config: SceneConfig,
): Promise<Scene[]> {
  const scenes: Scene[] = [];

  for (const [name, props] of resolved.builtins) {
    const scene = await loadBuiltinScene(name, { ...config, ...props });
    if (scene) scenes.push(scene);
  }

  for (const [path, props] of resolved.files) {
    const scene = await loadFileScene(path, { ...config, ...props });
    if (scene) scenes.push(scene);
  }

  return scenes;
}

/**
 * Load a builtin scene by name from the registry.
 *
 * Returns `null` and logs an error when the name is not found or
 * resolves to an alias (alias expansion should happen before calling
 * this function).
 *
 * @param name - Registered builtin scene name
 * @param config - Configuration passed to the scene factory
 * @returns The built scene, or `null` on failure
 */
export async function loadBuiltinScene(
  name: string,
  config: SceneConfig,
): Promise<Scene | null> {
  const factory = builtinSceneRegistry.get(name);

  if (!factory) {
    console.error(`[haruna][${name}] failed to load: unknown builtin`);
    return null;
  }
  if (Array.isArray(factory)) {
    console.error(`[haruna][${name}] failed to load: ${name} is an alias`);
    return null;
  }

  return buildScene(factory, config);
}

/**
 * Load a file-based scene module via dynamic `import()`.
 *
 * The module's default export must be a {@link SceneFactory} that
 * produces a valid {@link Scene}. Returns `null` and logs an error
 * when the import fails or the exported value is not a valid scene.
 *
 * @param path - Absolute file path to the scene module
 * @param config - Configuration passed to the scene factory
 * @returns The built scene, or `null` on failure
 */
export async function loadFileScene(
  path: string,
  config: SceneConfig,
): Promise<Scene | null> {
  try {
    const mod = await import(`${path}?v=${Date.now()}`);
    // `as SceneFactory` is unsound — the module may export anything.
    // `buildScene` passes non-functions through as-is, so the `isScene`
    // check below is the real runtime guard.
    const exported = mod.default as SceneFactory;
    const scene = buildScene(exported, config);

    if (!isScene(scene)) throw new Error("created object is not a valid scene");

    return scene;
  } catch (e) {
    console.error(
      `haruna: scene: ${path}: failed to load: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

/**
 * Build a {@link Scene} from {@link SceneFactory}.
 *
 * @param factory - The scene factory
 * @param config - Configuration passed to factory functions
 * @returns The built scene instance
 */
function buildScene(factory: SceneFactory, config: SceneConfig): Scene {
  return typeof factory === "function" ? factory(config) : factory;
}
