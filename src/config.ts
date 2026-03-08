/**
 * Configuration file loading, schema validation, init resolution,
 * command building, file discovery, and scene entry resolution.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as v from "valibot";
import { builtinSceneRegistry, expandBuiltinSceneAliases } from "./scene/builtin/registry.ts";
import { expandGlobs } from "./util/file.ts";

const GatewayEntrySchema = v.pipe(
  v.union([v.string(), v.objectWithRest({ type: v.string() }, v.unknown())]),
  v.transform((input) => (typeof input === "string" ? { type: input } : input)),
);

const ConfigSchema = v.object({
  command: v.optional(v.union([v.string(), v.pipe(v.array(v.string()), v.minLength(1))])),
  init: v.optional(v.union([v.string(), v.pipe(v.array(v.string()), v.minLength(1))])),
  terminal: v.optional(
    v.object({
      cols: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 80),
      rows: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 24),
      scrollback: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 500),
      debounceMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 100),
      maxIntervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 300),
    }),
    {},
  ),
  scenes: v.optional(
    v.array(v.union([v.string(), v.objectWithRest({ type: v.string() }, v.unknown())])),
    ["builtin", ".haruna-scene/*.ts"],
  ),
  channels: v.optional(
    v.array(
      v.pipe(
        v.union([v.string(), v.record(v.string(), v.unknown())]),
        v.transform((input) => (typeof input === "string" ? { type: input } : input)),
        v.variant("type", [
          v.object({
            type: v.literal("web"),
            port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
            host: v.optional(v.string(), "127.0.0.1"),
            waitForClient: v.optional(v.boolean()),
          }),
          v.object({
            type: v.literal("dump"),
            dir: v.optional(v.string()),
            path: v.optional(v.string()),
          }),
          v.object({
            type: v.literal("discord"),
            token: v.optional(
              v.pipe(
                v.string(),
                v.minLength(1, "token is required (set in config or $DISCORD_TOKEN)"),
              ),
              () => process.env.DISCORD_TOKEN ?? "",
            ),
            channel: v.optional(
              v.pipe(
                v.string(),
                v.minLength(1, "channel is required (set in config or $DISCORD_CHANNEL)"),
              ),
              () => process.env.DISCORD_CHANNEL ?? "",
            ),
            allowUsers: v.optional(
              v.pipe(
                v.union([v.string(), v.array(v.string())]),
                v.transform((val) => (Array.isArray(val) ? val : [val])),
              ),
              () => ["*"],
            ),
            allowOtherBots: v.optional(v.boolean(), false),
            requireMention: v.optional(v.boolean(), false),
            echo: v.optional(v.boolean(), false),
          }),
          v.object({
            type: v.literal("slack"),
            appToken: v.optional(
              v.pipe(
                v.string(),
                v.minLength(1, "appToken is required (set in config or $SLACK_APP_TOKEN)"),
              ),
              () => process.env.SLACK_APP_TOKEN ?? "",
            ),
            botToken: v.optional(
              v.pipe(
                v.string(),
                v.minLength(1, "botToken is required (set in config or $SLACK_BOT_TOKEN)"),
              ),
              () => process.env.SLACK_BOT_TOKEN ?? "",
            ),
            channel: v.optional(
              v.pipe(
                v.string(),
                v.minLength(1, "channel is required (set in config or $SLACK_CHANNEL)"),
              ),
              () => process.env.SLACK_CHANNEL ?? "",
            ),
            thread: v.optional(v.string(), () => process.env.SLACK_THREAD),
            allowUsers: v.optional(
              v.pipe(
                v.union([v.string(), v.array(v.string())]),
                v.transform((val) => (Array.isArray(val) ? val : [val])),
              ),
              () => ["*"],
            ),
            allowOtherBots: v.optional(v.boolean(), false),
            botUser: v.optional(v.string(), () => process.env.SLACK_BOT_USER),
            requireMention: v.optional(v.boolean(), false),
            echo: v.optional(v.boolean(), false),
          }),
        ]),
      ),
    ),
    [],
  ),
  gateways: v.optional(v.array(GatewayEntrySchema), []),
});

/** Raw validated configuration from the schema. */
type ConfigSource = v.InferOutput<typeof ConfigSchema>;

const InitConfigSourceSchema = v.strictObject({
  command: v.optional(v.union([v.string(), v.pipe(v.array(v.string()), v.minLength(1))])),
});

/**
 * Output produced by an init command.
 *
 * Currently limited to `command` override only. Callers that run
 * {@link Config.runInit} receive this value and can later pass it to
 * {@link Config.applyInitOutput} to merge the overrides into a Config.
 */
export type InitOutput = v.InferOutput<typeof InitConfigSourceSchema>;

/** Terminal emulator settings. */
export type TerminalConfig = ConfigSource["terminal"];

/** Scene entry — either a plain DSL string or an object with `type` and extras. */
export type SceneEntry = ConfigSource["scenes"][number];

/** Channel entry — discriminated union on the `type` field. */
export type ChannelEntry = ConfigSource["channels"][number];

/** Gateway entry — object with `type` and arbitrary per-gateway properties. */
export type GatewayEntry = ConfigSource["gateways"][number];

/**
 * Immutable configuration object that encapsulates the config file path
 * and provides methods for reloading and scene resolution.
 */
export class Config {
  /** Absolute path to the config file, or `null` when using defaults. */
  readonly path: string | null;
  /**
   * Base directory for resolving relative paths (scene globs, dump output, etc.).
   *
   * When a config file is present, this is the directory containing the config file.
   * Otherwise, it falls back to the working directory passed at load time.
   */
  readonly baseDir: string;
  /**
   * Command to run in the PTY.
   *
   * String form is executed via `bash -c`;
   * array form is executed directly (exec form).
   */
  readonly command: string | string[] | undefined;
  /**
   * Init command, invoked once before session start.
   *
   * Present only on unresolved configs. After {@link resolve} this is `undefined`.
   */
  readonly init: string | string[] | undefined;
  /** Terminal emulator settings. */
  readonly terminal: TerminalConfig;
  /** Scene entries from configuration. */
  readonly scenes: SceneEntry[];
  /** Channel entries from configuration. */
  readonly channels: ChannelEntry[];
  /** Gateway entries from configuration (used in multiplexing mode). */
  readonly gateways: GatewayEntry[];

  constructor(source: ConfigSource, path: string | null, baseDir: string) {
    this.path = path;
    this.baseDir = baseDir;
    this.command = source.command;
    this.init = source.init;
    this.terminal = source.terminal;
    this.scenes = source.scenes;
    this.channels = source.channels;
    this.gateways = source.gateways;
  }

  /**
   * Read a config file from `path` and construct a Config instance.
   *
   * When `path` is `null`, returns a Config with default values.
   *
   * @param path - Absolute path to the config file, or `null` for defaults
   * @param baseDir - Base directory for resolving relative paths
   * @returns A new Config instance
   */
  static async load(path: string | null, baseDir: string): Promise<Config> {
    if (!path) return new Config(parseConfig(null), null, baseDir);

    const content = interpolateEnvVars(await Bun.file(path).text());
    return new Config(parseConfig(Bun.YAML.parse(content)), path, baseDir);
  }

  /**
   * Reload configuration from the same file path.
   *
   * Returns a fresh, unresolved Config. Callers that need init output
   * re-applied must call {@link applyInitOutput} with the stored output.
   *
   * @returns A new Config instance with fresh data from disk
   */
  async reload(): Promise<Config> {
    return Config.load(this.path, this.baseDir);
  }

  /**
   * Run the init command and return its output.
   *
   * The init command's stdout is parsed as YAML and validated.
   * This method does not modify the Config — call {@link applyInitOutput}
   * to merge the result.
   *
   * @param args - Arguments passed to the init command
   * @returns Parsed init output
   * @throws When no init command is configured, or the command fails
   */
  async runInit(args: string[]): Promise<InitOutput> {
    if (!this.init) throw new Error("No init command configured");
    return runInit(this.init, args, this.baseDir);
  }

  /**
   * Apply init output overrides to this Config.
   *
   * Returns a new Config with `init` cleared and the init output merged.
   *
   * @param initOutput - Output from {@link runInit}
   * @returns A new resolved Config
   */
  applyInitOutput(initOutput: InitOutput): Config {
    const source: ConfigSource = {
      command: initOutput.command ?? this.command,
      init: undefined,
      terminal: this.terminal,
      scenes: this.scenes,
      channels: this.channels,
      gateways: this.gateways,
    };
    return new Config(source, this.path, this.baseDir);
  }

  /**
   * Build an argv array from the `command` field and extra arguments.
   *
   * When `command` is set, `extraArgs` are appended. When `command` is
   * unset, `extraArgs` are used as the command itself, falling back to
   * `$SHELL` or `/bin/sh`.
   *
   * @param extraArgs - CLI arguments to append or use as fallback command
   * @returns An argv array suitable for `Bun.spawn`
   */
  buildCommand(extraArgs: string[]): string[] {
    if (this.init) {
      throw new Error("Config.applyInitOutput() must be called before buildCommand()");
    }
    if (this.command === undefined) {
      return extraArgs.length > 0 ? extraArgs : [process.env.SHELL || "/bin/sh"];
    }
    return buildCommand(this.command, extraArgs);
  }

  /**
   * Compute the file paths that should be watched for hot-reload.
   *
   * Returns the config file path (when present) plus all resolved
   * scene file paths.
   */
  async fileWatchTargets(): Promise<string[]> {
    const targets: string[] = [];
    if (this.path) targets.push(this.path);
    const resolved = await this.resolveSceneEntries();
    targets.push(...resolved.files.keys());
    return targets;
  }

  /**
   * Resolve scene entries against the builtin registry and filesystem.
   *
   * Builtin aliases are expanded via the registry. File globs are expanded
   * against {@link baseDir}. Entries prefixed with `!` are treated as exclusions.
   * Per-entry properties (any key other than `type`) are accumulated and
   * available in the result maps.
   *
   * @returns Resolved builtin names and file paths with their properties
   */
  async resolveSceneEntries(): Promise<ResolvedSceneEntries> {
    const builtinAliases: Map<string, Record<string, unknown>> = new Map();
    const fileGlobs: Map<string, Record<string, unknown>> = new Map();
    const excludedBuiltinAliases: string[] = [];
    const excludedFileGlobs: string[] = [];

    for (const entry of this.scenes) {
      const { type, ...props } = typeof entry === "string" ? { type: entry } : entry;

      if (type.startsWith("!")) {
        const excluded = type.substring(1);
        if (builtinSceneRegistry.has(excluded)) {
          excludedBuiltinAliases.push(excluded);
        } else {
          excludedFileGlobs.push(excluded);
        }
      } else {
        if (builtinSceneRegistry.has(type)) {
          builtinAliases.set(type, { ...builtinAliases.get(type), ...props });
        } else {
          fileGlobs.set(type, { ...fileGlobs.get(type), ...props });
        }
      }
    }

    const excludedBuiltins = new Set(expandBuiltinSceneAliases(excludedBuiltinAliases));
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
      for (const p of await expandGlobs([fileGlob], this.baseDir, excludedFileGlobs)) {
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
export function findConfigFile(cwd: string): string | null {
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
 * Build an argv array from a command/init config field and extra arguments.
 *
 * - String form: executed via `bash -c` with args shell-escaped and appended.
 * - Array form: executed directly with args appended.
 */
function buildCommand(base: string | string[], args: string[]): string[] {
  if (typeof base === "string") {
    const fullCmd = args.length > 0 ? `${base} ${args.map(shellEscape).join(" ")}` : base;
    return ["bash", "-c", fullCmd];
  }
  return [...base, ...args];
}

/** Escape a string for safe inclusion in a bash command line. */
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
    (_match, name: string, fallback: string | undefined) => env[name] ?? fallback ?? "",
  );
}

/**
 * Run an init command and parse its stdout as {@link InitOutput}.
 *
 * stderr is inherited (visible to the user).
 * Throws if the command exits with a non-zero code.
 */
async function runInit(
  initCommand: string | string[],
  args: string[],
  cwd: string,
): Promise<InitOutput> {
  const command = buildCommand(initCommand, args);
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`init command exited with code ${exitCode}`);
  }

  const stdout = await new Response(proc.stdout).text();
  if (!stdout.trim()) return {};

  return v.parse(InitConfigSourceSchema, Bun.YAML.parse(stdout) ?? {});
}
