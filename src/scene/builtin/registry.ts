/**
 * Registry of built-in scene factories.
 *
 * Each entry maps a scene name to a factory that produces a
 * fresh {@link Scene} instance with independent state.
 *
 * @module
 */

import type { SceneFactory } from "../interface.ts";
import shellScene from "./shell.ts";

/**
 * All registered built-in scene factories and aliases, keyed by name.
 *
 * An entry whose value is a `string[]` is an **alias** that expands to
 * the listed names. Aliases are resolved transitively by
 * {@link expandBuiltinSceneAliases}, so **cyclic references must be
 * avoided** — they will cause infinite recursion.
 */
export const builtinSceneRegistry: ReadonlyMap<
  string,
  SceneFactory | string[]
> = new Map<string, SceneFactory | string[]>([
  ["shell", shellScene],
  ["builtin", ["shell"]],
]);

/**
 * Recursively expand builtin scene aliases into concrete scene names.
 *
 * Aliases (entries whose value is a `string[]`) are resolved transitively.
 * Names that do not exist in the registry are silently dropped.
 *
 * @param names - Builtin scene names or alias names to expand
 * @returns List of concrete (non-alias) builtin scene names (may contain duplicates)
 */
export function expandBuiltinSceneAliases(names: string[]): string[] {
  return names.flatMap((name) => {
    const record = builtinSceneRegistry.get(name);
    if (Array.isArray(record)) return expandBuiltinSceneAliases(record);
    if (record) return [name];
    return [];
  });
}
