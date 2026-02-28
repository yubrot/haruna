import { describe, expect, test } from "bun:test";
import { useTempDir } from "../__testing.ts";
import type { Scene } from "../scene/interface.ts";
import { snapshot } from "../vt/__testing.ts";
import { queryDump } from "./query.ts";
import { DumpWriter } from "./writer.ts";

/** A dummy scene that never matches — used to enable scene analysis in tests. */
const dummyScene: Scene = {
  priority: 999,
  state: null,
  detect() {
    return null;
  },
  continue() {
    return null;
  },
};

/** Default query with all sections disabled. Override as needed. */
function baseQuery(file: string) {
  return {
    file,
    stats: false,
    list: false,
    diff: null as 0 | 1 | 2 | null,
    scenes: null,
    count: 100,
    context: null as number | null,
  };
}

describe("queryDump", () => {
  const { tmpFile } = useTempDir("dump-test");

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  describe("stats", () => {
    test("returns command, duration, and record counts", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["claude", "--flag"] }, [
        snapshot(["a"], { timestamp: now }),
        snapshot(["b"], { timestamp: now + 1000 }),
        snapshot(["c"], { timestamp: now + 2000 }),
      ]);

      const result = await queryDump({ ...baseQuery(p), stats: true });
      expect(result.stats).toMatchObject({
        command: ["claude", "--flag"],
        duration: { start: now, end: now + 2000, seconds: 2 },
        records: { snapshots: 3 },
      });
      expect(result.stats?.records.keyframes).toBeGreaterThanOrEqual(1);
      expect(
        (result.stats?.records.keyframes ?? 0) +
          (result.stats?.records.deltas ?? 0),
      ).toBe(3);
    });

    test("returns null duration for empty dump", async () => {
      const p = tmpFile();
      await DumpWriter.writeAll(p, { command: ["test"] }, []);

      const result = await queryDump({ ...baseQuery(p), stats: true });
      expect(result.stats?.duration).toBeNull();
      expect(result.stats?.records.snapshots).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  describe("list", () => {
    test("returns all records without pattern", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // Use multi-line snapshots with different change patterns to avoid dedup
      await DumpWriter.writeAll(
        p,
        { command: ["test"] },
        [
          snapshot(["aaa", "bbb", "ccc"], { timestamp: now }),
          snapshot(["xxx", "bbb", "ccc"], { timestamp: now + 100 }),
          snapshot(["xxx", "yyy", "ccc"], { timestamp: now + 200 }),
        ],
        { keyframeIntervalMs: 999999 },
      );

      const result = await queryDump({ ...baseQuery(p), list: true });
      expect(result.list).toMatchObject({
        entries: [{ timestamp: now, totalLines: 3 }, {}, {}],
        nextFrom: null,
      });
    });

    test("filters by regex pattern", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["Allow Read?", "other"], { timestamp: now }),
        snapshot(["no match", "nope"], { timestamp: now + 100 }),
        snapshot(["Allow Write?", "ok"], { timestamp: now + 200 }),
      ]);

      const result = await queryDump({
        ...baseQuery(p),
        list: true,
        search: "Allow",
      });
      expect(result.list?.entries).toMatchObject([
        { matches: [{ text: "Allow Read?" }] },
        { matches: [{ text: "Allow Write?" }] },
      ]);
    });

    test("includes scene info when scene=true", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // Generic text won't match any scene
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["hello"], { timestamp: now }),
      ]);

      const result = await queryDump({
        ...baseQuery(p),
        list: true,
        scenes: [dummyScene],
      });
      expect(result.list?.entries.length).toBe(1);
      // state should be undefined since "hello" doesn't match any scene definition
      expect(result.list?.entries[0]?.state).toBeUndefined();
    });

    test("deduplicates consecutive snapshots with same changed lines", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // Three snapshots editing the same line — should collapse into one entry
      await DumpWriter.writeAll(
        p,
        { command: ["test"] },
        [
          snapshot(["aaa", "bbb"], { timestamp: now }),
          snapshot(["aaa", "bb1"], { timestamp: now + 100 }),
          snapshot(["aaa", "bb2"], { timestamp: now + 200 }),
          snapshot(["xxx", "bb2"], { timestamp: now + 300 }),
        ],
        { keyframeIntervalMs: 999999 },
      );

      const result = await queryDump({ ...baseQuery(p), list: true });
      // First snapshot (keyframe, no delta) is its own group.
      // Snapshots 2 and 3 both change line 1 → dedup group with endTimestamp.
      // Snapshot 4 changes line 0 → new group.
      expect(result.list?.entries).toMatchObject([
        { timestamp: now },
        { timestamp: now + 100, endTimestamp: now + 200 },
        { timestamp: now + 300 },
      ]);
      expect(result.list?.entries[0]?.endTimestamp).toBeUndefined();
      expect(result.list?.entries[2]?.endTimestamp).toBeUndefined();
    });

    test("deduplicates pattern matches with endTimestamp", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // First snapshot is keyframe (no delta, always new group).
      // Second and third both change line 0 → dedup group.
      // Fourth changes line 1 → new group.
      await DumpWriter.writeAll(
        p,
        { command: ["test"] },
        [
          snapshot(["Allow Read?", "other"], { timestamp: now }),
          snapshot(["Allow Read!", "other"], { timestamp: now + 100 }),
          snapshot(["Allow Read~", "other"], { timestamp: now + 200 }),
          snapshot(["Allow Read~", "Write!"], { timestamp: now + 300 }),
        ],
        { keyframeIntervalMs: 999999 },
      );

      const result = await queryDump({
        ...baseQuery(p),
        list: true,
        search: "Allow|Write",
      });
      // Entry 1: keyframe (Allow Read?, own group)
      // Entry 2+3: both change line 0 → dedup (Allow Read!, endTimestamp=now+200)
      // Entry 4: changes line 1 → new group (Allow Read~ and Write! match)
      expect(result.list?.entries).toMatchObject([
        { matches: [{ text: "Allow Read?" }] },
        { matches: [{ text: "Allow Read!" }], endTimestamp: now + 200 },
        { timestamp: now + 300 },
      ]);
      expect(result.list?.entries[0]?.endTimestamp).toBeUndefined();
    });

    test("dedup consumes count budget per raw snapshot", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // 5 snapshots editing line 0 + 1 different; count=5 should fit exactly the 5
      await DumpWriter.writeAll(
        p,
        { command: ["test"] },
        [
          snapshot(["aaa", "bbb"], { timestamp: now }),
          snapshot(["aa1", "bbb"], { timestamp: now + 100 }),
          snapshot(["aa2", "bbb"], { timestamp: now + 200 }),
          snapshot(["aa3", "bbb"], { timestamp: now + 300 }),
          snapshot(["aa4", "bbb"], { timestamp: now + 400 }),
          snapshot(["aa4", "xxx"], { timestamp: now + 500 }),
        ],
        { keyframeIntervalMs: 999999 },
      );

      const result = await queryDump({
        ...baseQuery(p),
        list: true,
        count: 5,
      });
      // First is keyframe (no delta), then 4 deltas all changing line 0 → dedup group
      expect(result.list).toMatchObject({
        entries: [{ timestamp: now }, { endTimestamp: now + 400 }],
        nextFrom: now + 500,
      });
    });

    test("returns nextFrom for pagination", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // Use snapshots that change different lines to avoid dedup
      await DumpWriter.writeAll(
        p,
        { command: ["test"] },
        [
          snapshot(["a", "b", "c", "d", "e"], { timestamp: now }),
          snapshot(["X", "b", "c", "d", "e"], { timestamp: now + 100 }),
          snapshot(["X", "Y", "c", "d", "e"], { timestamp: now + 200 }),
          snapshot(["X", "Y", "Z", "d", "e"], { timestamp: now + 300 }),
          snapshot(["X", "Y", "Z", "W", "e"], { timestamp: now + 400 }),
        ],
        { keyframeIntervalMs: 999999 },
      );

      const page1 = await queryDump({
        ...baseQuery(p),
        list: true,
        count: 2,
      });
      expect(page1.list).toMatchObject({
        entries: [{ timestamp: now }, { timestamp: now + 100 }],
        nextFrom: now + 200,
      });

      // Page 2 using nextFrom
      const page2 = await queryDump({
        ...baseQuery(p),
        list: true,
        from: page1.list?.nextFrom as number,
        count: 2,
      });
      expect(page2.list).toMatchObject({
        entries: [{ timestamp: now + 200 }, { timestamp: now + 300 }],
        nextFrom: now + 400,
      });

      // Page 3 — last entry, no more
      const page3 = await queryDump({
        ...baseQuery(p),
        list: true,
        from: page2.list?.nextFrom as number,
        count: 2,
      });
      expect(page3.list).toMatchObject({
        entries: [{ timestamp: now + 400 }],
        nextFrom: null,
      });
    });

    test("respects from/to time range", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // Use snapshots that change different lines to avoid dedup
      await DumpWriter.writeAll(
        p,
        { command: ["test"] },
        [
          snapshot(["a", "b", "c", "d", "e"], { timestamp: now }),
          snapshot(["X", "b", "c", "d", "e"], { timestamp: now + 100 }),
          snapshot(["X", "Y", "c", "d", "e"], { timestamp: now + 200 }),
          snapshot(["X", "Y", "Z", "d", "e"], { timestamp: now + 300 }),
          snapshot(["X", "Y", "Z", "W", "e"], { timestamp: now + 400 }),
        ],
        { keyframeIntervalMs: 999999 },
      );

      const result = await queryDump({
        ...baseQuery(p),
        list: true,
        from: now + 100,
        to: now + 300,
      });
      expect(result.list).toMatchObject({
        entries: [{ timestamp: now + 100 }, {}, { timestamp: now + 300 }],
        nextFrom: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot (--at)
  // -------------------------------------------------------------------------

  describe("snapshot", () => {
    test("returns snapshot at specified timestamp", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["line 0", "line 1", "line 2"], { timestamp: now }),
        snapshot(["changed", "line 1", "line 2"], { timestamp: now + 100 }),
      ]);

      const result = await queryDump({ ...baseQuery(p), at: now + 100 });
      expect(result.snapshot).toMatchObject({
        timestamp: now + 100,
        cols: 80,
        rows: 24,
        cursor: { x: 0, y: 0, visible: true },
        lines: ["changed", "line 1", "line 2"],
      });
    });

    test("returns no snapshot for timestamp before first snapshot", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["hello"], { timestamp: now }),
      ]);

      const result = await queryDump({ ...baseQuery(p), at: now - 1 });
      expect(result.snapshot).toBeUndefined();
    });

    test("includes scene info when scene=true", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // Generic text — scene should be absent in result
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["hello"], { timestamp: now }),
      ]);

      const result = await queryDump({
        ...baseQuery(p),
        at: now,
        scenes: [dummyScene],
      });
      expect(result.snapshot).toBeDefined();
      // "hello" doesn't match any scene, so state field should be absent
      expect(result.snapshot?.state).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Diff
  // -------------------------------------------------------------------------

  describe("diff", () => {
    /** Helper to query diff only (goes through the shared iteration loop). */
    async function queryDiff(
      file: string,
      level: 0 | 1 | 2,
      options: { from?: number; to?: number; count?: number } = {},
    ) {
      const result = await queryDump({
        ...baseQuery(file),
        diff: level,
        from: options.from,
        to: options.to,
        count: options.count ?? 100,
      });
      return result.diff ?? [];
    }

    test("level 0: returns single diff between first and last", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["a"], { timestamp: now }),
        snapshot(["b"], { timestamp: now + 100 }),
        snapshot(["c"], { timestamp: now + 200 }),
      ]);

      const diffs = await queryDiff(p, 0);
      expect(diffs).toMatchObject([{ from: now, to: now + 200 }]);
      expect(diffs[0]?.changes).toContain("-a");
      expect(diffs[0]?.changes).toContain("+c");
    });

    test("level 0: returns empty for single snapshot", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["a"], { timestamp: now }),
      ]);

      const diffs = await queryDiff(p, 0);
      expect(diffs.length).toBe(0);
    });

    test("level 0: respects count in shared loop", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["a"], { timestamp: now }),
        snapshot(["b"], { timestamp: now + 100 }),
        snapshot(["c"], { timestamp: now + 200 }),
        snapshot(["d"], { timestamp: now + 300 }),
      ]);

      // count=2 limits to first 2 snapshots: diff a→b
      const diffs = await queryDiff(p, 0, { count: 2 });
      expect(diffs).toMatchObject([{ from: now, to: now + 100 }]);
    });

    test("level 0 exception: diff=0 + explicit to + no list bypasses count", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["a"], { timestamp: now }),
        snapshot(["b"], { timestamp: now + 100 }),
        snapshot(["c"], { timestamp: now + 200 }),
        snapshot(["d"], { timestamp: now + 300 }),
      ]);

      // count=2 but with explicit --to and no --list → exception path
      const result = await queryDump({
        ...baseQuery(p),
        diff: 0,
        count: 2,
        to: now + 300,
      });
      // Should see all 4 snapshots (count ignored), diff a→d
      expect(result.diff).toMatchObject([{ from: now, to: now + 300 }]);
    });

    test("level 0: respects --to boundary via shared loop", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["a"], { timestamp: now }),
        snapshot(["b"], { timestamp: now + 100 }),
        snapshot(["c"], { timestamp: now + 200 }),
        snapshot(["d"], { timestamp: now + 300 }),
      ]);

      // With --list, the exception path is NOT taken → shared loop with count
      const result = await queryDump({
        ...baseQuery(p),
        list: true,
        diff: 0,
        to: now + 200,
      });
      expect(result.diff).toMatchObject([{ to: now + 200 }]);
      expect(result.diff?.[0]?.changes).toContain("+c");
    });

    test("level 2: returns sequential diffs between all snapshots", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["a"], { timestamp: now }),
        snapshot(["b"], { timestamp: now + 100 }),
        snapshot(["c"], { timestamp: now + 200 }),
      ]);

      const diffs = await queryDiff(p, 2);
      expect(diffs).toMatchObject([
        { from: now, to: now + 100 },
        { from: now + 100, to: now + 200 },
      ]);
    });

    test("level 1: groups by changed line indices and diffs between groups", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // Line edits on line 0, then line 1 changes → new group
      await DumpWriter.writeAll(
        p,
        { command: ["test"] },
        [
          snapshot(["aaa", "bbb"], { timestamp: now }),
          snapshot(["aa1", "bbb"], { timestamp: now + 100 }),
          snapshot(["aa2", "bbb"], { timestamp: now + 200 }),
          snapshot(["aa2", "bb1"], { timestamp: now + 300 }),
        ],
        { keyframeIntervalMs: 999999 },
      );

      const diffs = await queryDiff(p, 1);
      // Group 1: ts=now (keyframe, no delta → own group)
      // Group 2: ts=now+100, now+200 (both change line 0)
      // Group 3: ts=now+300 (changes line 1)
      // Diffs: group1→group2 boundary, group2 within-group, group2→group3 boundary
      expect(diffs).toMatchObject([
        { from: now, to: now + 100 },
        { from: now + 100, to: now + 200 },
        { from: now + 200, to: now + 300 },
      ]);
    });

    test("level 1: emits within-group diff for single group with internal changes", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // Keyframe (own group) + 3 snapshots all changing line 0 (single group)
      await DumpWriter.writeAll(
        p,
        { command: ["test"] },
        [
          snapshot(["aaa", "bbb"], { timestamp: now }),
          snapshot(["aa1", "bbb"], { timestamp: now + 100 }),
          snapshot(["aa2", "bbb"], { timestamp: now + 200 }),
          snapshot(["aa3", "bbb"], { timestamp: now + 300 }),
        ],
        { keyframeIntervalMs: 999999 },
      );

      const diffs = await queryDiff(p, 1);
      // Group 1: ts=now (keyframe, no delta → own group)
      // Group 2: ts=now+100..now+300 (all change line 0)
      // Diffs: group1→group2 boundary + group2 within-group (first..last of group)
      expect(diffs).toMatchObject([
        { from: now, to: now + 100 },
        { from: now + 100, to: now + 300 },
      ]);
    });

    test("level 2: respects count limit", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      await DumpWriter.writeAll(p, { command: ["test"] }, [
        snapshot(["a"], { timestamp: now }),
        snapshot(["b"], { timestamp: now + 100 }),
        snapshot(["c"], { timestamp: now + 200 }),
        snapshot(["d"], { timestamp: now + 300 }),
      ]);

      const diffs = await queryDiff(p, 2, { count: 2 });
      // count=2 means consume 2 snapshots, producing 1 diff
      expect(diffs.length).toBe(1);
    });

    test("list and diff share count budget", async () => {
      const p = tmpFile();
      const now = 1700000000000;
      // Use snapshots that change different lines to avoid dedup
      await DumpWriter.writeAll(
        p,
        { command: ["test"] },
        [
          snapshot(["a", "b", "c", "d"], { timestamp: now }),
          snapshot(["X", "b", "c", "d"], { timestamp: now + 100 }),
          snapshot(["X", "Y", "c", "d"], { timestamp: now + 200 }),
          snapshot(["X", "Y", "Z", "d"], { timestamp: now + 300 }),
        ],
        { keyframeIntervalMs: 999999 },
      );

      const result = await queryDump({
        ...baseQuery(p),
        list: true,
        diff: 2,
        count: 3,
      });
      // count=3 → 3 snapshots consumed → 3 list entries, 2 diffs
      expect(result.list?.entries.length).toBe(3);
      expect(result.diff?.length).toBe(2);
      // 4th snapshot should be nextFrom
      expect(result.list?.nextFrom).toBe(now + 300);
    });
  });

  // -------------------------------------------------------------------------
  // Combined
  // -------------------------------------------------------------------------

  test("returns only requested sections", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    await DumpWriter.writeAll(p, { command: ["test"] }, [
      snapshot(["a"], { timestamp: now }),
    ]);

    const result = await queryDump({ ...baseQuery(p), stats: true });
    expect(result.stats).toBeDefined();
    expect(result.list).toBeUndefined();
    expect(result.diff).toBeUndefined();
    expect(result.snapshot).toBeUndefined();
  });

  test("combines multiple sections in one query", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    await DumpWriter.writeAll(p, { command: ["test"] }, [
      snapshot(["a"], { timestamp: now }),
      snapshot(["b"], { timestamp: now + 100 }),
    ]);

    const result = await queryDump({
      ...baseQuery(p),
      stats: true,
      list: true,
      diff: 0,
      at: now,
    });
    expect(result.stats).toBeDefined();
    expect(result.list).toBeDefined();
    expect(result.diff).toBeDefined();
    expect(result.snapshot).toBeDefined();
  });

  test("throws for non-existent file", async () => {
    await expect(
      queryDump({ ...baseQuery("/tmp/no-such-file-dump-test.dump") }),
    ).rejects.toThrow();
  });
});
