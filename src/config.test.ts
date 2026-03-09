import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
      expect(config.baseDir).toBe(dir);
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
  });

  describe("parseConfig", () => {
    test("accepts channel string shorthand", () => {
      const source = parseConfig({ channels: ["dump", "web"] });
      expect(source.channels).toMatchObject([
        { type: "dump" },
        { type: "web", port: 0, host: "127.0.0.1" },
      ]);
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
});
