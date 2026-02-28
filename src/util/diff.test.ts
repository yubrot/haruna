import { describe, expect, test } from "bun:test";
import {
  collapseDiffContext,
  computeEditScript,
  computeLineDiff,
  type EditOp,
} from "./diff.ts";

describe("computeEditScript", () => {
  test("empty sequences produce empty script", () => {
    expect(computeEditScript([], [])).toEqual([]);
  });

  test("empty from produces all inserts", () => {
    const ops = computeEditScript([], ["a", "b"]);
    expect(ops).toEqual([
      { type: "insert", toIdx: 0 },
      { type: "insert", toIdx: 1 },
    ]);
  });

  test("empty to produces all deletes", () => {
    const ops = computeEditScript(["a", "b"], []);
    expect(ops).toEqual([
      { type: "delete", fromIdx: 0 },
      { type: "delete", fromIdx: 1 },
    ]);
  });

  test("identical sequences produce all keeps", () => {
    const ops = computeEditScript(["a", "b", "c"], ["a", "b", "c"]);
    expect(ops).toEqual([
      { type: "keep", fromIdx: 0, toIdx: 0 },
      { type: "keep", fromIdx: 1, toIdx: 1 },
      { type: "keep", fromIdx: 2, toIdx: 2 },
    ]);
  });

  test("single replacement", () => {
    const ops = computeEditScript(["a", "b", "c"], ["a", "X", "c"]);
    expect(ops).toEqual([
      { type: "keep", fromIdx: 0, toIdx: 0 },
      { type: "delete", fromIdx: 1 },
      { type: "insert", toIdx: 1 },
      { type: "keep", fromIdx: 2, toIdx: 2 },
    ]);
  });

  test("shift pattern: leading deletes + trailing inserts", () => {
    const ops = computeEditScript(["A", "B", "C", "D"], ["B", "C", "D", "E"]);
    // Should detect: delete A, keep B/C/D, insert E
    const deletes = ops.filter((o) => o.type === "delete");
    const inserts = ops.filter((o) => o.type === "insert");
    const keeps = ops.filter((o) => o.type === "keep");
    expect(deletes).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    expect(keeps).toHaveLength(3);
  });

  test("custom equality function", () => {
    const ops = computeEditScript([1, 2, 3], [1, 2, 3], (a, b) => a === b);
    expect(ops.every((o) => o.type === "keep")).toBe(true);
  });

  /** Apply edit script to verify it transforms from into to. */
  function applyOps<T>(from: T[], to: T[], ops: EditOp[]): T[] {
    const result: T[] = [];
    for (const op of ops) {
      switch (op.type) {
        case "keep":
          result.push(from[op.fromIdx] as T);
          break;
        case "insert":
          result.push(to[op.toIdx] as T);
          break;
        case "delete":
          break;
      }
    }
    return result;
  }

  test("roundtrip: applying ops transforms from into to", () => {
    const from = ["A", "B", "C", "D", "E"];
    const to = ["B", "C", "X", "D", "F"];
    const ops = computeEditScript(from, to);
    expect(applyOps(from, to, ops)).toEqual(to);
  });

  test("completely different sequences", () => {
    const from = ["A", "B", "C"];
    const to = ["X", "Y", "Z"];
    const ops = computeEditScript(from, to);
    expect(applyOps(from, to, ops)).toEqual(to);
    // No keeps — all elements differ
    expect(ops.every((o) => o.type !== "keep")).toBe(true);
  });

  test("sequences with duplicate elements", () => {
    const from = ["A", "B", "A", "B", "A"];
    const to = ["B", "A", "B", "A", "B"];
    const ops = computeEditScript(from, to);
    expect(applyOps(from, to, ops)).toEqual(to);
  });

  test("single element sequences", () => {
    expect(computeEditScript(["A"], ["A"])).toEqual([
      { type: "keep", fromIdx: 0, toIdx: 0 },
    ]);
    const ops = computeEditScript(["A"], ["B"]);
    expect(applyOps(["A"], ["B"], ops)).toEqual(["B"]);
  });

  test("long common prefix with trailing changes", () => {
    const common = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const from = [...common, "old1", "old2"];
    const to = [...common, "new1", "new2", "new3"];
    const ops = computeEditScript(from, to);
    expect(applyOps(from, to, ops)).toEqual(to);
    // All common lines should be kept
    const keeps = ops.filter((o) => o.type === "keep");
    expect(keeps.length).toBe(20);
  });
});

describe("computeLineDiff", () => {
  test("returns empty string for identical inputs", () => {
    const result = computeLineDiff(["a", "b"], ["a", "b"]);
    expect(result).toBe("");
  });

  test("produces unified diff with +/- prefixes", () => {
    const result = computeLineDiff(["a", "b", "c"], ["a", "d", "c"]);
    const lines = result.split("\n");
    expect(lines[0]).toBe(" a");
    expect(lines).toContain("-b");
    expect(lines).toContain("+d");
    expect(lines[lines.length - 1]).toBe(" c");
  });

  test("handles additions", () => {
    const result = computeLineDiff(["a"], ["a", "b"]);
    expect(result).toContain("+b");
  });

  test("handles deletions", () => {
    const result = computeLineDiff(["a", "b"], ["a"]);
    expect(result).toContain("-b");
  });
});

describe("collapseDiffContext", () => {
  test("returns unchanged when context is null", () => {
    const diff = " a\n-b\n+c\n d";
    expect(collapseDiffContext(diff, null)).toBe(diff);
  });

  test("returns unchanged for empty diff", () => {
    expect(collapseDiffContext("", 3)).toBe("");
  });

  test("returns unchanged when all lines are within context", () => {
    const diff = " a\n-b\n+c\n d";
    expect(collapseDiffContext(diff, 3)).toBe(diff);
  });

  test("omits distant common lines with separator", () => {
    // 10 common lines, then a change, then 10 common lines
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(` common${i}`);
    lines.push("-old");
    lines.push("+new");
    for (let i = 10; i < 20; i++) lines.push(` common${i}`);
    const diff = lines.join("\n");

    const result = collapseDiffContext(diff, 2);
    const resultLines = result.split("\n");

    // 2 context before change + change + 2 context after change
    // Leading and trailing omitted regions get separators
    expect(resultLines).toEqual([
      "@@ 8 lines omitted @@",
      " common8",
      " common9",
      "-old",
      "+new",
      " common10",
      " common11",
      "@@ 8 lines omitted @@",
    ]);
  });

  test("context=0 shows only changed lines", () => {
    const diff = " a\n b\n-c\n+d\n e\n f";
    const result = collapseDiffContext(diff, 0);
    const resultLines = result.split("\n");
    expect(resultLines).toEqual([
      "@@ 2 lines omitted @@",
      "-c",
      "+d",
      "@@ 2 lines omitted @@",
    ]);
  });

  test("merges overlapping context regions", () => {
    // change, 2 common lines, change — with context=2 should keep everything
    const diff = "-a\n+b\n c\n d\n-e\n+f";
    const result = collapseDiffContext(diff, 2);
    expect(result).toBe(diff);
  });
});
