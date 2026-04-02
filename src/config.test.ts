import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTempDir } from "./__testing.ts";
import { Config, findConfigFile, interpolateEnvVars, parseConfig } from "./config.ts";

function writeScene(dir: string, fileName: string, label: string): string {
  const path = join(dir, fileName);
  writeFileSync(
    path,
    `export default {
      priority: 10,
      state: "${label}",
      detect() { return null; },
      continue() { return null; },
    };`,
  );
  return path;
}

describe("interpolateEnvVars", () => {
  // Build placeholder strings dynamically to avoid
  // Biome's noTemplateCurlyInString lint rule on string literals.
  function v(name: string, fallback?: string): string {
    const inner = fallback !== undefined ? `${name}:${fallback}` : name;
    return `\${${inner}}`;
  }

  test("expands variable from env", () => {
    expect(interpolateEnvVars(`token: ${v("MY_TOKEN")}`, { MY_TOKEN: "secret" })).toBe(
      "token: secret",
    );
  });

  test("expands variable with default when env value present", () => {
    expect(
      interpolateEnvVars(`host: ${v("HOST", "localhost")}`, {
        HOST: "example.com",
      }),
    ).toBe("host: example.com");
  });

  test("uses default when env var is unset", () => {
    expect(interpolateEnvVars(`host: ${v("HOST", "localhost")}`, {})).toBe("host: localhost");
  });

  test("uses empty string when env var is unset and no default", () => {
    expect(interpolateEnvVars(`token: ${v("MISSING")}`, {})).toBe("token: ");
  });

  test("expands multiple placeholders", () => {
    expect(interpolateEnvVars(`${v("A")}-${v("B")}`, { A: "hello", B: "world" })).toBe(
      "hello-world",
    );
  });

  test("leaves text without placeholders unchanged", () => {
    expect(interpolateEnvVars("no vars here", {})).toBe("no vars here");
  });

  test("handles empty default value", () => {
    expect(interpolateEnvVars(`val: ${v("X", "")}`, {})).toBe("val: ");
  });
});

describe("Config", () => {
  const { dir } = useTempDir("config-test");

  describe("findConfigFile", () => {
    test("finds .haruna.yaml in cwd", () => {
      writeFileSync(join(dir, ".haruna.yaml"), "terminal:\n  scrollback: 100\n");
      expect(findConfigFile(dir)).toBe(join(dir, ".haruna.yaml"));
    });

    test("finds .haruna.yml in cwd", () => {
      writeFileSync(join(dir, ".haruna.yml"), "channels: []\n");
      expect(findConfigFile(dir)).toBe(join(dir, ".haruna.yml"));
    });

    test("prefers .haruna.yml over .haruna.yaml", () => {
      writeFileSync(join(dir, ".haruna.yaml"), "scenes: []\n");
      writeFileSync(join(dir, ".haruna.yml"), "scenes: []\n");
      expect(findConfigFile(dir)).toBe(join(dir, ".haruna.yml"));
    });

    test("finds config in parent directory", () => {
      const child = join(dir, "subdir");
      mkdirSync(child, { recursive: true });
      writeFileSync(join(dir, ".haruna.yaml"), "scenes: []\n");
      expect(findConfigFile(child)).toBe(join(dir, ".haruna.yaml"));
    });

    test("returns null when no config file exists", () => {
      expect(findConfigFile(dir)).toBeNull();
    });
  });

  describe("load", () => {
    test("loads config from a file", async () => {
      const configPath = join(dir, ".haruna.yaml");
      writeFileSync(configPath, "terminal:\n  scrollback: 42\n");
      const config = await Config.load(configPath, dir);
      expect(config.path).toBe(configPath);
      expect(config.terminal.scrollback).toBe(42);
      expect(config.baseDir).toBe(dir);
    });

    test("returns defaults when path is null", async () => {
      const config = await Config.load(null, dir);
      expect(config.path).toBeNull();
      expect(config.terminal.scrollback).toBe(500);
      expect(config.command).toBeUndefined();
      expect(config.init).toBeUndefined();
      expect(config.gateways).toEqual([]);
      expect(config.baseDir).toBe(dir);
    });

    test("loads command, init and gateways from a file", async () => {
      const configPath = join(dir, ".haruna.yaml");
      writeFileSync(
        configPath,
        "command: claude --verbose\ninit: ./init.sh\ngateways:\n  - type: web\n    port: 7800\n",
      );
      const config = await Config.load(configPath, dir);
      expect(config.command).toBe("claude --verbose");
      expect(config.init).toBe("./init.sh");
      expect(config.gateways).toMatchObject([{ type: "web", port: 7800 }]);
    });

    test("sets baseDir to the provided value", async () => {
      const sub = join(dir, "configs");
      mkdirSync(sub, { recursive: true });
      const configPath = join(sub, "my-config.yml");
      writeFileSync(configPath, "scenes: []\n");
      const config = await Config.load(configPath, sub);
      expect(config.baseDir).toBe(sub);
    });
  });

  describe("reload", () => {
    test("reloads from the same path", async () => {
      const configPath = join(dir, ".haruna.yaml");
      writeFileSync(configPath, "terminal:\n  scrollback: 100\n");

      const config = await Config.load(configPath, dir);
      expect(config.terminal.scrollback).toBe(100);

      writeFileSync(configPath, "terminal:\n  scrollback: 200\n");
      const reloaded = await config.reload();
      expect(reloaded.terminal.scrollback).toBe(200);
      expect(reloaded.path).toBe(configPath);
    });

    test("returns defaults when path is null", async () => {
      const config = new Config(parseConfig(null), null, dir);
      const reloaded = await config.reload();
      expect(reloaded.path).toBeNull();
      expect(reloaded.terminal.scrollback).toBe(500);
    });

    test("preserves baseDir after reload", async () => {
      const configPath = join(dir, ".haruna.yaml");
      writeFileSync(configPath, "terminal:\n  scrollback: 100\n");
      const config = await Config.load(configPath, dir);
      const reloaded = await config.reload();
      expect(reloaded.baseDir).toBe(config.baseDir);
    });

    test("applyInitOutput re-applies to reloaded config", async () => {
      const scriptPath = join(dir, "init-reload.sh");
      writeFileSync(scriptPath, '#!/bin/bash\necho "command: from-init"\n');
      chmodSync(scriptPath, 0o755);

      const configPath = join(dir, ".haruna.yml");
      writeFileSync(configPath, `init: ${scriptPath}\nterminal:\n  scrollback: 100\n`);
      const config = await Config.load(configPath, dir);

      const initOutput = await config.runInit([]);
      const resolved = config.applyInitOutput(initOutput);
      expect(resolved.command).toBe("from-init");
      expect(resolved.terminal.scrollback).toBe(100);

      // Change config file — caller re-applies init output after reload
      writeFileSync(configPath, `init: ${scriptPath}\nterminal:\n  scrollback: 200\n`);
      const reloaded = (await config.reload()).applyInitOutput(initOutput);
      expect(reloaded.command).toBe("from-init");
      expect(reloaded.terminal.scrollback).toBe(200);
      expect(reloaded.init).toBeUndefined();
    });

    test("reload returns unresolved config (init present)", async () => {
      const scriptPath = join(dir, "init-reload2.sh");
      writeFileSync(scriptPath, '#!/bin/bash\necho "command: stable"\n');
      chmodSync(scriptPath, 0o755);

      const configPath = join(dir, ".haruna.yml");
      writeFileSync(configPath, `init: ${scriptPath}\n`);
      const config = await Config.load(configPath, dir);

      // reload always returns an unresolved config
      const reloaded = await config.reload();
      expect(reloaded.init).toBe(scriptPath);

      // caller applies init output to produce a resolved config
      const initOutput = await config.runInit([]);
      const resolved = reloaded.applyInitOutput(initOutput);
      expect(resolved.init).toBeUndefined();
      expect(resolved.command).toBe("stable");
    });
  });

  describe("parseConfig", () => {
    test("accepts channel string shorthand", () => {
      const source = parseConfig({ channels: ["dump", "web"] });
      expect(source.channels).toMatchObject([
        { type: "dump" },
        { type: "web", port: 0, host: "127.0.0.1" },
      ]);
    });

    test("accepts command as string (shell form)", () => {
      const source = parseConfig({ command: "claude --verbose" });
      expect(source.command).toBe("claude --verbose");
    });

    test("accepts command as array of strings (exec form)", () => {
      const source = parseConfig({ command: ["claude", "--session-id", "my session"] });
      expect(source.command).toEqual(["claude", "--session-id", "my session"]);
    });

    test("defaults command to undefined", () => {
      const source = parseConfig({});
      expect(source.command).toBeUndefined();
    });

    test("accepts init as string (shell form)", () => {
      const source = parseConfig({ init: "./init.sh" });
      expect(source.init).toBe("./init.sh");
    });

    test("accepts init as array of strings (exec form)", () => {
      const source = parseConfig({ init: ["./init.sh", "--flag"] });
      expect(source.init).toEqual(["./init.sh", "--flag"]);
    });

    test("defaults init to undefined", () => {
      const source = parseConfig({});
      expect(source.init).toBeUndefined();
    });

    test("accepts gateway string shorthand", () => {
      const source = parseConfig({ gateways: ["web"] });
      expect(source.gateways).toMatchObject([{ type: "web" }]);
    });

    test("accepts gateway object with properties", () => {
      const source = parseConfig({
        gateways: [{ type: "web", port: 8080, host: "0.0.0.0" }],
      });
      expect(source.gateways).toMatchObject([{ type: "web", port: 8080, host: "0.0.0.0" }]);
    });

    test("applies gateway defaults for port and host", () => {
      const source = parseConfig({ gateways: ["web"] });
      expect(source.gateways).toMatchObject([{ type: "web", port: 0, host: "127.0.0.1" }]);
    });

    test("defaults gateways to empty array", () => {
      const source = parseConfig({});
      expect(source.gateways).toEqual([]);
    });

    test("rejects non-string/array command", () => {
      expect(() => parseConfig({ command: 123 })).toThrow();
    });

    test("rejects empty array command", () => {
      expect(() => parseConfig({ command: [] })).toThrow();
    });

    test("rejects non-string/array init", () => {
      expect(() => parseConfig({ init: true })).toThrow();
    });

    test("rejects empty array init", () => {
      expect(() => parseConfig({ init: [] })).toThrow();
    });

    test("rejects non-array gateways", () => {
      expect(() => parseConfig({ gateways: "web" })).toThrow();
    });

    test("rejects unknown channel name string", () => {
      expect(() => parseConfig({ channels: ["unknown"] })).toThrow();
    });

    test("accepts web channel object with custom properties", () => {
      const source = parseConfig({
        channels: [{ type: "web", port: 9000, host: "0.0.0.0" }],
      });
      expect(source.channels).toMatchObject([{ type: "web", port: 9000, host: "0.0.0.0" }]);
    });
  });

  // NOTE: The builtin registry currently contains no concrete scene factories.
  // Tests for builtin property accumulation, builtin exclusion, and mixed
  // builtin + file entries cannot be meaningfully verified until concrete
  // builtins are registered.

  describe("resolveSceneEntries", () => {
    // TODO: Add tests for builtin property accumulation, builtin exclusion
    // ("!builtinName"), and mixed builtin + file entries once concrete
    // builtins are registered

    function configWith(scenes: unknown[], baseDir?: string): Config {
      return new Config(parseConfig({ scenes }), null, baseDir ?? dir);
    }

    test("empty entries returns empty maps", async () => {
      const result = await configWith([]).resolveSceneEntries();
      expect(result.builtins.size).toBe(0);
      expect(result.files.size).toBe(0);
    });

    test("builtin alias expands to registered entries", async () => {
      const result = await configWith(["builtin"]).resolveSceneEntries();
      expect(result.builtins.has("shell")).toBe(true);
      expect(result.files.size).toBe(0);
    });

    test("resolves file glob patterns", async () => {
      writeScene(dir, "my-scene.ts", "my-scene");

      const result = await configWith(["*.ts"]).resolveSceneEntries();
      expect(result.files.size).toBe(1);
      expect([...result.files.keys()][0]).toEndWith("my-scene.ts");
    });

    test("excludes files matching negated glob", async () => {
      writeScene(dir, "scene-a.ts", "scene-a");
      writeScene(dir, "scene-a.test.ts", "scene-a-test");

      const result = await configWith(["*.ts", "!*.test.ts"]).resolveSceneEntries();
      expect(result.files.size).toBe(1);
      expect([...result.files.keys()][0]).toEndWith("scene-a.ts");
    });

    test("resolves globs from subdirectories", async () => {
      const sub = join(dir, "scenes");
      mkdirSync(sub, { recursive: true });
      writeScene(sub, "nested.ts", "nested");

      const result = await configWith(["scenes/*.ts"]).resolveSceneEntries();
      expect(result.files.size).toBe(1);
      expect([...result.files.keys()][0]).toEndWith("nested.ts");
    });

    test("deduplicates files matched by multiple patterns", async () => {
      writeScene(dir, "scene.ts", "scene");

      const result = await configWith(["*.ts", "scene.ts"]).resolveSceneEntries();
      expect(result.files.size).toBe(1);
    });

    test("returns empty files for glob with no matches", async () => {
      const result = await configWith(["*.ts"]).resolveSceneEntries();
      expect(result.files.size).toBe(0);
    });

    test("accumulates per-entry properties", async () => {
      writeScene(dir, "scene.ts", "scene");
      writeScene(dir, "other.ts", "other");

      const result = await configWith([
        { type: "*.ts", color: "red" },
        { type: "scene.ts", size: 10 },
      ]).resolveSceneEntries();
      expect(result.files.size).toBe(2);
      const fileEntries = new Map(
        [...result.files.entries()].map(([k, v]) => [k.split("/").pop(), v]),
      );
      expect(fileEntries.get("scene.ts")).toEqual({ color: "red", size: 10 });
      expect(fileEntries.get("other.ts")).toEqual({ color: "red" });
    });

    test("resolves globs relative to baseDir", async () => {
      const scenesDir = join(dir, "project");
      mkdirSync(scenesDir, { recursive: true });
      writeScene(scenesDir, "proj-scene.ts", "proj-scene");

      const result = await configWith(["*.ts"], scenesDir).resolveSceneEntries();
      expect(result.files.size).toBe(1);
      expect([...result.files.keys()][0]).toEndWith("proj-scene.ts");
    });
  });

  describe("fileWatchTargets", () => {
    function configWith(scenes: unknown[], path: string | null = null, baseDir?: string): Config {
      return new Config(parseConfig({ scenes }), path, baseDir ?? dir);
    }

    test("returns empty array when no config path and no scene files", async () => {
      const targets = await configWith([]).fileWatchTargets();
      expect(targets).toEqual([]);
    });

    test("includes config path when present", async () => {
      const configPath = join(dir, ".haruna.yml");
      writeFileSync(configPath, "scenes: []\n");
      const targets = await configWith([], configPath).fileWatchTargets();
      expect(targets).toContain(configPath);
    });

    test("includes resolved scene file paths", async () => {
      const scenePath = writeScene(dir, "watch-scene.ts", "watch");
      const targets = await configWith(["*.ts"]).fileWatchTargets();
      expect(targets).toContain(scenePath);
    });

    test("includes both config path and scene files", async () => {
      const configPath = join(dir, ".haruna.yml");
      writeFileSync(configPath, "scenes: []\n");
      const scenePath = writeScene(dir, "both-scene.ts", "both");
      const targets = await configWith(["*.ts"], configPath).fileWatchTargets();
      expect(targets).toContain(configPath);
      expect(targets).toContain(scenePath);
    });

    test("does not include builtin scenes", async () => {
      const targets = await configWith(["builtin"]).fileWatchTargets();
      expect(targets).toEqual([]);
    });
  });

  describe("runInit / applyInitOutput", () => {
    function writeScript(name: string, content: string): string {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/bash\n${content}\n`);
      chmodSync(path, 0o755);
      return path;
    }

    test("runInit throws when init is not set", async () => {
      const config = new Config(parseConfig({ command: "claude" }), null, dir);
      await expect(config.runInit([])).rejects.toThrow("No init command configured");
    });

    test("merges init output with config", async () => {
      const script = writeScript("init.sh", 'echo "command: overridden"');
      const configPath = join(dir, ".haruna.yml");
      writeFileSync(configPath, `init: ${script}\ncommand: original\n`);
      const config = await Config.load(configPath, dir);

      const initOutput = await config.runInit([]);
      const resolved = config.applyInitOutput(initOutput);
      expect(resolved.command).toBe("overridden");
    });

    test("clears init after applyInitOutput", async () => {
      const script = writeScript("init-clear.sh", 'echo "command: resolved"');
      const configPath = join(dir, ".haruna.yml");
      writeFileSync(configPath, `init: ${script}\n`);
      const config = await Config.load(configPath, dir);

      const initOutput = await config.runInit([]);
      const resolved = config.applyInitOutput(initOutput);
      expect(resolved.init).toBeUndefined();
    });

    test("applyInitOutput preserves command when init outputs nothing", async () => {
      const script = writeScript("noop.sh", "# no output");
      const configPath = join(dir, ".haruna.yml");
      writeFileSync(configPath, `init: ${script}\ncommand: claude\n`);
      const config = await Config.load(configPath, dir);

      const initOutput = await config.runInit([]);
      const resolved = config.applyInitOutput(initOutput);
      expect(resolved.command).toBe("claude");
      expect(resolved.init).toBeUndefined();
    });

    test("passes args to the init command", async () => {
      const script = writeScript("id-init.sh", 'echo "command: session-$1"');
      const configPath = join(dir, ".haruna.yml");
      writeFileSync(configPath, `init: ${script}\n`);
      const config = await Config.load(configPath, dir);

      const initOutput = await config.runInit(["myid", "abc123"]);
      const resolved = config.applyInitOutput(initOutput);
      expect(resolved.command).toBe("session-myid");
    });

    test("preserves non-command fields from base config", async () => {
      const script = writeScript("init-preserve.sh", 'echo "command: from-init"');
      const configPath = join(dir, ".haruna.yml");
      writeFileSync(
        configPath,
        `init: ${script}\ncommand: original\nterminal:\n  cols: 120\n  scrollback: 1000\nchannels:\n  - dump\n`,
      );
      const config = await Config.load(configPath, dir);

      const initOutput = await config.runInit([]);
      const resolved = config.applyInitOutput(initOutput);
      expect(resolved.command).toBe("from-init");
      expect(resolved.terminal.cols).toBe(120);
      expect(resolved.terminal.scrollback).toBe(1000);
      expect(resolved.channels).toMatchObject([{ type: "dump" }]);
    });

    test("rejects unknown fields in init output", async () => {
      const script = writeScript("init-unknown.sh", 'echo "channels:\n  - dump"');
      const configPath = join(dir, ".haruna.yml");
      writeFileSync(configPath, `init: ${script}\n`);
      const config = await Config.load(configPath, dir);

      await expect(config.runInit([])).rejects.toThrow();
    });
  });

  describe("buildCommand", () => {
    test("throws when init is still set", () => {
      const config = new Config(parseConfig({ init: "./init.sh" }), null, "/tmp");
      expect(() => config.buildCommand([])).toThrow(
        "Config.applyInitOutput() must be called before buildCommand()",
      );
    });

    test("undefined command with no args falls back to SHELL or /bin/sh", () => {
      const config = new Config(parseConfig({}), null, "/tmp");
      const result = config.buildCommand([]);
      expect(result).toEqual([process.env.SHELL || "/bin/sh"]);
    });

    test("undefined command with args uses args as command", () => {
      const config = new Config(parseConfig({}), null, "/tmp");
      expect(config.buildCommand(["my-cmd", "--flag"])).toEqual(["my-cmd", "--flag"]);
    });

    test("string command with no args uses bash -c", () => {
      const config = new Config(parseConfig({ command: "claude" }), null, "/tmp");
      expect(config.buildCommand([])).toEqual(["bash", "-c", "claude"]);
    });

    test("string command with args appends shell-escaped args", () => {
      const config = new Config(parseConfig({ command: "claude" }), null, "/tmp");
      expect(config.buildCommand(["--verbose"])).toEqual(["bash", "-c", "claude '--verbose'"]);
    });

    test("array command with no args", () => {
      const config = new Config(parseConfig({ command: ["claude", "--no-cache"] }), null, "/tmp");
      expect(config.buildCommand([])).toEqual(["claude", "--no-cache"]);
    });

    test("array command with args appends directly", () => {
      const config = new Config(parseConfig({ command: ["claude"] }), null, "/tmp");
      expect(config.buildCommand(["--verbose"])).toEqual(["claude", "--verbose"]);
    });
  });
});
