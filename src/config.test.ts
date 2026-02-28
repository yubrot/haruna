import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTempDir } from "./__testing.ts";
import { Config, interpolateEnvVars, parseConfig } from "./config.ts";

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
    expect(
      interpolateEnvVars(`token: ${v("MY_TOKEN")}`, { MY_TOKEN: "secret" }),
    ).toBe("token: secret");
  });

  test("expands variable with default when env value present", () => {
    expect(
      interpolateEnvVars(`host: ${v("HOST", "localhost")}`, {
        HOST: "example.com",
      }),
    ).toBe("host: example.com");
  });

  test("uses default when env var is unset", () => {
    expect(interpolateEnvVars(`host: ${v("HOST", "localhost")}`, {})).toBe(
      "host: localhost",
    );
  });

  test("uses empty string when env var is unset and no default", () => {
    expect(interpolateEnvVars(`token: ${v("MISSING")}`, {})).toBe("token: ");
  });

  test("expands multiple placeholders", () => {
    expect(
      interpolateEnvVars(`${v("A")}-${v("B")}`, { A: "hello", B: "world" }),
    ).toBe("hello-world");
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

  describe("load", () => {
    test("finds .haruna.yaml in cwd", async () => {
      const configPath = join(dir, ".haruna.yaml");
      writeFileSync(configPath, "terminal:\n  scrollback: 100\n");
      const config = await Config.load(dir);
      expect(config.path).toBe(configPath);
      expect(config.terminal.scrollback).toBe(100);
    });

    test("finds .haruna.yml in cwd", async () => {
      const configPath = join(dir, ".haruna.yml");
      writeFileSync(configPath, "channels: []\n");
      const config = await Config.load(dir);
      expect(config.path).toBe(configPath);
    });

    test("prefers .haruna.yml over .haruna.yaml", async () => {
      writeFileSync(join(dir, ".haruna.yaml"), "scenes: []\n");
      writeFileSync(join(dir, ".haruna.yml"), "scenes: []\n");
      const config = await Config.load(dir);
      expect(config.path).toBe(join(dir, ".haruna.yml"));
    });

    test("finds config in parent directory", async () => {
      const child = join(dir, "subdir");
      mkdirSync(child, { recursive: true });
      const configPath = join(dir, ".haruna.yaml");
      writeFileSync(configPath, "scenes: []\n");
      const config = await Config.load(child);
      expect(config.path).toBe(configPath);
    });

    test("returns defaults when no config file exists", async () => {
      const config = await Config.load(dir);
      expect(config.path).toBeNull();
      expect(config.terminal.scrollback).toBe(500);
    });
  });

  describe("reload", () => {
    test("reloads from the same path", async () => {
      const configPath = join(dir, ".haruna.yaml");
      writeFileSync(configPath, "terminal:\n  scrollback: 100\n");

      const config = await Config.load(dir);
      expect(config.terminal.scrollback).toBe(100);

      writeFileSync(configPath, "terminal:\n  scrollback: 200\n");
      const reloaded = await config.reload();
      expect(reloaded.terminal.scrollback).toBe(200);
      expect(reloaded.path).toBe(configPath);
    });

    test("returns defaults when path is null", async () => {
      const config = new Config(parseConfig(null), null);
      const reloaded = await config.reload();
      expect(reloaded.path).toBeNull();
      expect(reloaded.terminal.scrollback).toBe(500);
    });
  });

  describe("parseConfig", () => {
    test("accepts channel string shorthand", () => {
      const source = parseConfig({ channels: ["dump", "web"] });
      expect(source.channels).toMatchObject([
        { name: "dump" },
        { name: "web", port: 0, host: "127.0.0.1" },
      ]);
    });

    test("rejects unknown channel name string", () => {
      expect(() => parseConfig({ channels: ["unknown"] })).toThrow();
    });

    test("accepts web channel object with custom properties", () => {
      const source = parseConfig({
        channels: [{ name: "web", port: 9000, host: "0.0.0.0" }],
      });
      expect(source.channels).toMatchObject([
        { name: "web", port: 9000, host: "0.0.0.0" },
      ]);
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

    function configWith(scenes: unknown[]): Config {
      return new Config(parseConfig({ scenes }), null);
    }

    test("empty entries returns empty maps", async () => {
      const result = await configWith([]).resolveSceneEntries(dir);
      expect(result.builtins.size).toBe(0);
      expect(result.files.size).toBe(0);
    });

    test("builtin alias expands to registered entries", async () => {
      const result = await configWith(["builtin"]).resolveSceneEntries(dir);
      expect(result.builtins.has("shell")).toBe(true);
      expect(result.files.size).toBe(0);
    });

    test("resolves file glob patterns", async () => {
      writeScene(dir, "my-scene.ts", "my-scene");

      const result = await configWith(["*.ts"]).resolveSceneEntries(dir);
      expect(result.files.size).toBe(1);
      expect([...result.files.keys()][0]).toEndWith("my-scene.ts");
    });

    test("excludes files matching negated glob", async () => {
      writeScene(dir, "scene-a.ts", "scene-a");
      writeScene(dir, "scene-a.test.ts", "scene-a-test");

      const result = await configWith([
        "*.ts",
        "!*.test.ts",
      ]).resolveSceneEntries(dir);
      expect(result.files.size).toBe(1);
      expect([...result.files.keys()][0]).toEndWith("scene-a.ts");
    });

    test("resolves globs from subdirectories", async () => {
      const sub = join(dir, "scenes");
      mkdirSync(sub, { recursive: true });
      writeScene(sub, "nested.ts", "nested");

      const result = await configWith(["scenes/*.ts"]).resolveSceneEntries(dir);
      expect(result.files.size).toBe(1);
      expect([...result.files.keys()][0]).toEndWith("nested.ts");
    });

    test("deduplicates files matched by multiple patterns", async () => {
      writeScene(dir, "scene.ts", "scene");

      const result = await configWith(["*.ts", "scene.ts"]).resolveSceneEntries(
        dir,
      );
      expect(result.files.size).toBe(1);
    });

    test("returns empty files for glob with no matches", async () => {
      const result = await configWith(["*.ts"]).resolveSceneEntries(dir);
      expect(result.files.size).toBe(0);
    });

    test("accumulates per-entry properties", async () => {
      writeScene(dir, "scene.ts", "scene");
      writeScene(dir, "other.ts", "other");

      const result = await configWith([
        { src: "*.ts", color: "red" },
        { src: "scene.ts", size: 10 },
      ]).resolveSceneEntries(dir);
      expect(result.files.size).toBe(2);
      const fileEntries = new Map(
        [...result.files.entries()].map(([k, v]) => [k.split("/").pop(), v]),
      );
      expect(fileEntries.get("scene.ts")).toEqual({ color: "red", size: 10 });
      expect(fileEntries.get("other.ts")).toEqual({ color: "red" });
    });
  });
});
