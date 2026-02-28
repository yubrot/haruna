/**
 * Configuration file loading, schema validation, file discovery, and
 * scene entry resolution.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as v from "valibot";
import {
  builtinSceneRegistry,
  expandBuiltinSceneAliases,
} from "./scene/builtin/registry.ts";
import { expandGlobs } from "./util/file.ts";

const ConfigSchema = v.object({
  terminal: v.optional(
    v.object({
      cols: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 80),
      rows: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 24),
      scrollback: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0)),
        500,
      ),
      debounceMs: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0)),
        100,
      ),
      maxIntervalMs: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0)),
        300,
      ),
    }),
    {},
  ),
  scenes: v.optional(
    v.array(
      v.union([v.string(), v.objectWithRest({ src: v.string() }, v.unknown())]),
    ),
    ["builtin", ".haruna-scene/*.ts"],
  ),
  channels: v.optional(
    v.array(
      v.pipe(
        v.union([v.string(), v.record(v.string(), v.unknown())]),
        v.transform((input) =>
          typeof input === "string" ? { name: input } : input,
        ),
        v.variant("name", [
          v.object({
            name: v.literal("web"),
            port: v.optional(
              v.pipe(v.number(), v.integer(), v.minValue(0)),
              7800,
            ),
            host: v.optional(v.string(), "127.0.0.1"),
            waitForClient: v.optional(v.boolean()),
          }),
          v.object({
            name: v.literal("dump"),
            dir: v.optional(v.string()),
            path: v.optional(v.string()),
          }),
        ]),
      ),
    ),
    [{ name: "dump" }],
  ),
});

/** Raw validated configuration from the schema. */
type ConfigSource = v.InferOutput<typeof ConfigSchema>;

/** Terminal emulator settings. */
export type TerminalConfig = ConfigSource["terminal"];

/** Scene entry — either a plain DSL string or an object with `src` and extras. */
export type SceneEntry = ConfigSource["scenes"][number];

/** Channel entry — discriminated union on the `name` field. */
export type ChannelEntry = ConfigSource["channels"][number];

/**
 * Immutable configuration object that encapsulates the config file path
 * and provides methods for reloading and scene resolution.
 */
export class Config {
  /** Absolute path to the config file, or `null` when using defaults. */
  readonly path: string | null;
  /** Terminal emulator settings. */
  readonly terminal: TerminalConfig;
  /** Scene entries from configuration. */
  readonly scenes: SceneEntry[];
  /** Channel entries from configuration. */
  readonly channels: ChannelEntry[];

  constructor(source: ConfigSource, path: string | null) {
    this.path = path;
    this.terminal = source.terminal;
    this.scenes = source.scenes;
    this.channels = source.channels;
  }

  /**
   * Find and load a config file by walking up from `cwd`.
   *
   * When no config file is found, returns a Config with default values.
   *
   * @param cwd - The directory to start searching from
   * @returns A new Config instance
   */
  static async load(cwd: string): Promise<Config> {
    const path = findConfigFile(cwd);
    if (!path) return new Config(parseConfig(null), null);

    const content = interpolateEnvVars(await Bun.file(path).text());
    return new Config(parseConfig(Bun.YAML.parse(content)), path);
  }

  /**
   * Reload configuration from the same file path.
   *
   * @returns A new Config instance with fresh data from disk
   */
  async reload(): Promise<Config> {
    if (!this.path) return new Config(parseConfig(null), null);

    const content = interpolateEnvVars(await Bun.file(this.path).text());
    return new Config(parseConfig(Bun.YAML.parse(content)), this.path);
  }

  /**
   * Resolve scene entries against the builtin registry and filesystem.
   *
   * Builtin aliases are expanded via the registry. File globs are expanded
   * against {@link cwd}. Entries prefixed with `!` are treated as exclusions.
   * Per-entry properties (any key other than `src`) are accumulated and
   * available in the result maps.
   *
   * @param cwd - Working directory for glob resolution
   * @returns Resolved builtin names and file paths with their properties
   */
  async resolveSceneEntries(cwd: string): Promise<ResolvedSceneEntries> {
    const builtinAliases: Map<string, Record<string, unknown>> = new Map();
    const fileGlobs: Map<string, Record<string, unknown>> = new Map();
    const excludedBuiltinAliases: string[] = [];
    const excludedFileGlobs: string[] = [];

    for (const entry of this.scenes) {
      const { src, ...props } =
        typeof entry === "string" ? { src: entry } : entry;

      if (src.startsWith("!")) {
        const excludedSrc = src.substring(1);
        if (builtinSceneRegistry.has(excludedSrc)) {
          excludedBuiltinAliases.push(excludedSrc);
        } else {
          excludedFileGlobs.push(excludedSrc);
        }
      } else {
        if (builtinSceneRegistry.has(src)) {
          builtinAliases.set(src, { ...builtinAliases.get(src), ...props });
        } else {
          fileGlobs.set(src, { ...fileGlobs.get(src), ...props });
        }
      }
    }

    const excludedBuiltins = new Set(
      expandBuiltinSceneAliases(excludedBuiltinAliases),
    );
    const builtins: ResolvedSceneEntries["builtins"] = new Map();
    for (const [builtinAlias, props] of builtinAliases.entries()) {
      for (const name of expandBuiltinSceneAliases([builtinAlias])) {
        if (!excludedBuiltins.has(name)) {
          builtins.set(name, { ...builtins.get(name), ...props });
        }
      }
    }

    const files: ResolvedSceneEntries["files"] = new Map();
    for (const [fileGlob, props] of fileGlobs.entries()) {
      for (const p of await expandGlobs([fileGlob], cwd, excludedFileGlobs)) {
        files.set(p, { ...files.get(p), ...props });
      }
    }

    return { builtins, files };
  }
}

/**
 * Result of resolving scene entries against the builtin registry
 * and the filesystem.
 *
 * Each map key is the canonical scene identifier (builtin name or
 * absolute file path) and each value holds the extra per-entry
 * configuration properties from the config file.
 */
export interface ResolvedSceneEntries {
  /** Expanded builtin scene names with accumulated per-entry properties. */
  builtins: Map<string, Record<string, unknown>>;
  /** Absolute file paths with accumulated per-entry properties. */
  files: Map<string, Record<string, unknown>>;
}

const CONFIG_FILENAMES = [".haruna.yml", ".haruna.yaml"];

/**
 * Search for a config file by walking up from `cwd` toward the filesystem root.
 *
 * @param cwd - The directory to start searching from
 * @returns The absolute path to the config file, or `null` if not found
 */
function findConfigFile(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Validate and parse a raw value into a {@link ConfigSource}.
 *
 * Useful in tests for constructing Config instances from inline data.
 *
 * @param raw - The raw value (typically from YAML parsing)
 * @returns A validated ConfigSource with defaults applied
 * @throws {v.ValiError} If validation fails
 */
export function parseConfig(raw: unknown): ConfigSource {
  return v.parse(ConfigSchema, raw ?? {});
}

/**
 * Expand `${VAR}` and `${VAR:default}` placeholders in raw YAML text.
 *
 * Applied before YAML parsing so that secrets (tokens, keys) can be
 * kept in environment variables and referenced in `.haruna.yml`.
 *
 * - `${VAR}` — replaced with the value of `VAR`, or empty string if unset
 * - `${VAR:default}` — replaced with the value of `VAR`, or `"default"` if unset
 *
 * @param content - Raw YAML text
 * @param env - Environment variable source (defaults to `process.env`)
 * @returns The text with all placeholders expanded
 */
export function interpolateEnvVars(
  content: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return content.replace(
    /\$\{([^}:]+)(?::([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) =>
      env[name] ?? fallback ?? "",
  );
}
