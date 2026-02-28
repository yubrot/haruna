import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTempDir } from "../__testing.ts";
import { Config, parseConfig } from "../config.ts";
import { loadBuiltinScene, loadFileScene, loadScenes } from "./loader.ts";

const defaultConfig = { _mode: "exec" as const, _command: [] };

function configWith(scenes: unknown[]): Config {
  return new Config(parseConfig({ scenes }), null);
}

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

// NOTE: The builtin registry currently contains no concrete scene factories.
// loadBuiltinScene and loadScenes cannot test the builtin happy path
// (concrete name → Scene) until concrete builtins are registered.

describe("loadBuiltinScene", () => {
  // TODO: Add happy-path test once concrete builtins are registered

  test("returns null for unknown builtin name", async () => {
    const scene = await loadBuiltinScene("nonexistent", defaultConfig);
    expect(scene).toBeNull();
  });

  test("returns null for alias entries", async () => {
    // "builtin" is registered as an alias (string[])
    const scene = await loadBuiltinScene("builtin", defaultConfig);
    expect(scene).toBeNull();
  });
});

describe("loadFileScene", () => {
  const { dir } = useTempDir("loader-file-test");

  test("loads a valid scene object from file", async () => {
    const path = join(dir, "valid.ts");
    writeFileSync(
      path,
      `export default {
        priority: 1,
        state: "valid",
        detect() { return null; },
        continue() { return null; },
      };`,
    );

    const scene = await loadFileScene(path, defaultConfig);
    expect(scene).not.toBeNull();
    expect(scene?.state).toBe("valid");
    expect(scene?.priority).toBe(1);
  });

  test("loads a scene from factory function", async () => {
    const path = join(dir, "factory.ts");
    writeFileSync(
      path,
      `export default (config) => ({
        priority: 2,
        state: config._mode,
        detect() { return null; },
        continue() { return null; },
      });`,
    );

    const scene = await loadFileScene(path, defaultConfig);
    expect(scene).not.toBeNull();
    expect(scene?.state).toBe("exec");
  });

  test("returns null for invalid default export", async () => {
    const path = join(dir, "invalid.ts");
    writeFileSync(path, "export default 42;");

    const scene = await loadFileScene(path, defaultConfig);
    expect(scene).toBeNull();
  });

  test("returns null when import fails", async () => {
    const scene = await loadFileScene("/nonexistent/path.ts", defaultConfig);
    expect(scene).toBeNull();
  });

  test("passes config properties to factory", async () => {
    const path = join(dir, "config.ts");
    writeFileSync(
      path,
      `export default (config) => ({
        priority: 0,
        state: String(config.myProp),
        detect() { return null; },
        continue() { return null; },
      });`,
    );

    const scene = await loadFileScene(path, { ...defaultConfig, myProp: 42 });
    expect(scene).not.toBeNull();
    expect(scene?.state).toBe("42");
  });
});

describe("loadScenes", () => {
  // TODO: Add test for builtin loading and mixed builtin + file loading
  // once concrete builtins are registered

  const { dir } = useTempDir("loader-scenes-test");

  test("empty resolved entries returns no scenes", async () => {
    const resolved = { builtins: new Map(), files: new Map() };
    const scenes = await loadScenes(resolved, defaultConfig);
    expect(scenes).toEqual([]);
  });

  test("loads scenes from resolved file entries", async () => {
    writeScene(dir, "my-scene.ts", "my-scene");

    const resolved = await configWith(["*.ts"]).resolveSceneEntries(dir);
    const scenes = await loadScenes(resolved, defaultConfig);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.state).toBe("my-scene");
  });

  test("loads scene from factory function", async () => {
    const path = join(dir, "factory-scene.ts");
    writeFileSync(
      path,
      `export default () => ({
        priority: 5,
        state: "factory",
        detect() { return null; },
        continue() { return null; },
      });`,
    );

    const resolved = await configWith(["factory-scene.ts"]).resolveSceneEntries(
      dir,
    );
    const scenes = await loadScenes(resolved, defaultConfig);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.state).toBe("factory");
  });

  test("skips files with invalid default export", async () => {
    const path = join(dir, "invalid.ts");
    writeFileSync(path, "export default 42;");

    const resolved = await configWith(["invalid.ts"]).resolveSceneEntries(dir);
    expect(resolved.files.size).toBe(1);
    const scenes = await loadScenes(resolved, defaultConfig);
    expect(scenes).toHaveLength(0);
  });

  test("skips files that fail to import", async () => {
    const path = join(dir, "broken.ts");
    writeFileSync(path, "import { x } from './nonexistent';");

    const resolved = await configWith(["broken.ts"]).resolveSceneEntries(dir);
    expect(resolved.files.size).toBe(1);
    const scenes = await loadScenes(resolved, defaultConfig);
    expect(scenes).toHaveLength(0);
  });

  test("loads multiple file scenes together", async () => {
    writeScene(dir, "scene-a.ts", "a");
    writeScene(dir, "scene-b.ts", "b");

    const resolved = await configWith(["*.ts"]).resolveSceneEntries(dir);
    const scenes = await loadScenes(resolved, defaultConfig);
    expect(scenes).toHaveLength(2);
    const states = scenes.map((s) => s.state).sort();
    expect(states).toEqual(["a", "b"]);
  });

  test("merges per-entry properties into scene config", async () => {
    const path = join(dir, "config-scene.ts");
    writeFileSync(
      path,
      `export default (config) => ({
        priority: 1,
        state: config.color ?? "none",
        detect() { return null; },
        continue() { return null; },
      });`,
    );

    const resolved = await configWith([
      { src: "config-scene.ts", color: "blue" },
    ]).resolveSceneEntries(dir);
    const scenes = await loadScenes(resolved, defaultConfig);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.state).toBe("blue");
  });
});
