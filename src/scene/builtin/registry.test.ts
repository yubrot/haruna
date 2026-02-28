import { describe, expect, test } from "bun:test";
import { expandBuiltinSceneAliases } from "./registry.ts";

describe("expandBuiltinSceneAliases", () => {
  test("returns empty array for empty input", () => {
    expect(expandBuiltinSceneAliases([])).toEqual([]);
  });

  test("drops names not in the registry", () => {
    expect(expandBuiltinSceneAliases(["nonexistent"])).toEqual([]);
  });

  test("expands alias to its members", () => {
    const result = expandBuiltinSceneAliases(["builtin"]);
    expect(result).toEqual(["shell"]);
  });

  test("returns concrete (non-alias) names as-is", () => {
    const result = expandBuiltinSceneAliases(["shell", "unknown"]);
    expect(result).toEqual(["shell"]);
  });

  test("does not deduplicate when alias and concrete name overlap", () => {
    const result = expandBuiltinSceneAliases(["builtin", "shell"]);
    expect(result).toEqual(["shell", "shell"]);
  });
});
