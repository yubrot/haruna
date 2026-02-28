import { describe, expect, test } from "bun:test";
import { useTempDir } from "../__testing.ts";
import { snapshot } from "../vt/__testing.ts";
import type { Snapshot } from "../vt/snapshot.ts";
import { DumpReader, type SnapshotEntry } from "./reader.ts";
import { DumpWriter } from "./writer.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DumpReader", () => {
  const { tmpFile } = useTempDir("reader-test");

  test("header accessor returns session metadata", async () => {
    const p = tmpFile();
    await DumpWriter.writeAll(p, { command: ["test"] }, [snapshot()]);
    const reader = await DumpReader.open(p);
    expect(reader.header).toEqual({ command: ["test"] });
  });

  // -----------------------------------------------------------------------
  // stats
  // -----------------------------------------------------------------------

  test("stats.duration returns time range of snapshots", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots = [
      snapshot(["a"], { timestamp: now }),
      snapshot(["b"], { timestamp: now + 1000 }),
      snapshot(["c"], { timestamp: now + 2000 }),
    ];
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots);
    const reader = await DumpReader.open(p);
    expect(reader.stats.duration).toEqual({ start: now, end: now + 2000 });
    expect(reader.stats.keyframes + reader.stats.deltas).toBe(3);
    expect(reader.stats.keyframes).toBeGreaterThanOrEqual(1);
  });

  test("stats.duration is null for file with no snapshots", async () => {
    const p = tmpFile();
    await DumpWriter.writeAll(p, { command: ["test"] }, []);
    const reader = await DumpReader.open(p);
    expect(reader.stats).toMatchObject({
      duration: null,
      keyframes: 0,
      deltas: 0,
    });
  });

  // -----------------------------------------------------------------------
  // snapshots()
  // -----------------------------------------------------------------------

  test("snapshots() produces correct snapshots", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [
      snapshot(["hello"], { timestamp: now }),
      snapshot(["world"], { timestamp: now + 100 }),
      snapshot(["test!"], { timestamp: now + 200 }),
    ];
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots);
    const reader = await DumpReader.open(p);

    const result = [...reader.snapshots()];
    expect(result.length).toBe(3);
    for (let i = 0; i < snapshots.length; i++) {
      expect((result[i] as SnapshotEntry).snapshot).toEqual(
        snapshots[i] as Snapshot,
      );
    }
  });

  test("snapshots() with multi-field changes", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [
      {
        lines: ["line1", "line2"],
        cursor: { x: 0, y: 0, visible: true },
        cols: 80,
        rows: 24,
        alternate: false,
        linesOffset: 0,
        timestamp: now,
      },
      {
        lines: ["CHANGED", "line2", "new"],
        cursor: { x: 5, y: 2, visible: false },
        cols: 120,
        rows: 40,
        alternate: false,
        linesOffset: 0,
        timestamp: now + 100,
      },
    ];
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots);
    const reader = await DumpReader.open(p);

    const result = [...reader.snapshots()];
    expect(result.length).toBe(2);
    expect((result[0] as SnapshotEntry).snapshot).toEqual(
      snapshots[0] as Snapshot,
    );
    expect((result[1] as SnapshotEntry).snapshot).toEqual(
      snapshots[1] as Snapshot,
    );
  });

  test("snapshots(from) starts from the specified timestamp", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [];
    for (let i = 0; i < 10; i++) {
      snapshots.push(snapshot([`line-${i}`], { timestamp: now + i * 1000 }));
    }
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots, {
      keyframeIntervalMs: 3000,
    });
    const reader = await DumpReader.open(p);

    // Start from the 5th snapshot (index 4, timestamp = now + 4000)
    const result = [...reader.snapshots(now + 4000)];
    expect(result.length).toBe(6); // indices 4..9
    for (let i = 0; i < result.length; i++) {
      expect((result[i] as SnapshotEntry).snapshot).toEqual(
        snapshots[i + 4] as Snapshot,
      );
    }
  });

  test("snapshots(from) with timestamp between entries", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [
      snapshot(["a"], { timestamp: now }),
      snapshot(["b"], { timestamp: now + 1000 }),
      snapshot(["c"], { timestamp: now + 2000 }),
    ];
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots);
    const reader = await DumpReader.open(p);

    // from is between first and second — should yield from second
    const result = [...reader.snapshots(now + 500)];
    expect(result.length).toBe(2);
    expect((result[0] as SnapshotEntry).snapshot).toEqual(
      snapshots[1] as Snapshot,
    );
  });

  // -----------------------------------------------------------------------
  // SnapshotEntry.delta
  // -----------------------------------------------------------------------

  test("snapshots() returns null delta for keyframes", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    await DumpWriter.writeAll(p, { command: ["test"] }, [
      snapshot(["a"], { timestamp: now }),
    ]);
    const reader = await DumpReader.open(p);

    const result = [...reader.snapshots()];
    expect(result.length).toBe(1);
    expect((result[0] as SnapshotEntry).delta).toBeNull();
  });

  test("snapshots() returns delta info for delta records", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [
      snapshot(["a"], { timestamp: now }),
      snapshot(["b"], { timestamp: now + 100 }),
    ];
    // Force all into one keyframe group (large interval)
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots, {
      keyframeIntervalMs: 999999,
    });
    const reader = await DumpReader.open(p);

    const result = [...reader.snapshots()];
    expect(result.length).toBe(2);
    // First entry is a keyframe with no predecessor
    expect((result[0] as SnapshotEntry).delta).toBeNull();
    // Second entry should be a delta (since interval is large)
    if (reader.stats.deltas > 0) {
      const secondDelta = (result[1] as SnapshotEntry).delta;
      expect(secondDelta).not.toBeNull();
      expect(Array.isArray(secondDelta?.changedLines)).toBe(true);
      expect(typeof secondDelta?.scrolledLines).toBe("number");
    }
  });

  test("snapshots() returns changedLines as line index array", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [
      {
        lines: ["aaa", "bbb", "ccc"],
        cursor: { x: 0, y: 0, visible: true },
        cols: 80,
        rows: 24,
        alternate: false,
        linesOffset: 0,
        timestamp: now,
      },
      {
        lines: ["aaa", "BBB", "ccc"],
        cursor: { x: 0, y: 0, visible: true },
        cols: 80,
        rows: 24,
        alternate: false,
        linesOffset: 0,
        timestamp: now + 100,
      },
    ];
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots, {
      keyframeIntervalMs: 999999,
    });
    const reader = await DumpReader.open(p);

    const result = [...reader.snapshots()];
    expect(result.length).toBe(2);
    const secondDelta = (result[1] as SnapshotEntry).delta;
    expect(secondDelta).not.toBeNull();
    expect(secondDelta?.changedLines).toEqual([1]);
    expect(secondDelta?.scrolledLines).toBe(0);
  });

  // -----------------------------------------------------------------------
  // snapshotNearestTo
  // -----------------------------------------------------------------------

  test("snapshotNearestTo returns correct snapshot for exact timestamp", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [
      snapshot(["a"], { timestamp: now }),
      snapshot(["b"], { timestamp: now + 100 }),
      snapshot(["c"], { timestamp: now + 200 }),
    ];
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots);
    const reader = await DumpReader.open(p);

    const entry = reader.snapshotNearestTo(now + 100);
    expect(entry).not.toBeNull();
    expect(entry?.snapshot).toEqual(snapshots[1] as Snapshot);
  });

  test("snapshotNearestTo returns latest snapshot at or before timestamp", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [
      snapshot(["a"], { timestamp: now }),
      snapshot(["b"], { timestamp: now + 100 }),
      snapshot(["c"], { timestamp: now + 200 }),
    ];
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots);
    const reader = await DumpReader.open(p);

    // Between second and third snapshot
    const entry = reader.snapshotNearestTo(now + 150);
    expect(entry).not.toBeNull();
    expect(entry?.snapshot).toEqual(snapshots[1] as Snapshot);
  });

  test("snapshotNearestTo returns null before first timestamp", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    await DumpWriter.writeAll(p, { command: ["test"] }, [
      snapshot(["a"], { timestamp: now }),
    ]);
    const reader = await DumpReader.open(p);

    expect(reader.snapshotNearestTo(now - 1)).toBeNull();
  });

  test("snapshotNearestTo works across keyframe boundaries", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [];
    for (let i = 0; i < 10; i++) {
      snapshots.push(snapshot([`line-${i}`], { timestamp: now + i * 1000 }));
    }
    // Force keyframes every 3 seconds
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots, {
      keyframeIntervalMs: 3000,
    });
    const reader = await DumpReader.open(p);

    // Check each snapshot is reconstructable
    for (const expected of snapshots) {
      const entry = reader.snapshotNearestTo(expected.timestamp);
      expect(entry).not.toBeNull();
      expect(entry?.snapshot).toEqual(expected);
    }
  });

  test("snapshotNearestTo returns delta info for delta entries", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [];
    for (let i = 0; i < 5; i++) {
      snapshots.push(snapshot([`line-${i}`], { timestamp: now + i * 100 }));
    }
    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots, {
      keyframeIntervalMs: 999999,
    });
    const reader = await DumpReader.open(p);

    // First snapshot (keyframe) should have null delta
    const first = reader.snapshotNearestTo(now);
    expect(first?.delta).toBeNull();

    // Later snapshots should have delta info (if they're deltas)
    if (reader.stats.deltas > 0) {
      const last = reader.snapshotNearestTo(now + 400);
      expect(last?.delta).not.toBeNull();
    }
  });

  // -----------------------------------------------------------------------
  // Roundtrip
  // -----------------------------------------------------------------------

  test("roundtrip: many snapshots with varied content", async () => {
    const p = tmpFile();
    const now = 1700000000000;
    const snapshots: Snapshot[] = [];

    for (let i = 0; i < 20; i++) {
      snapshots.push({
        lines: [`line-${i}`, `content-${i % 3}`],
        cursor: { x: i % 10, y: i % 5, visible: i % 2 === 0 },
        cols: 80 + (i % 3) * 20,
        rows: 24 + (i % 2) * 10,
        alternate: false,
        linesOffset: 0,
        timestamp: now + i * 500,
      });
    }

    await DumpWriter.writeAll(p, { command: ["test"] }, snapshots, {
      keyframeIntervalMs: 2000,
    });
    const reader = await DumpReader.open(p);

    // Verify sequential iteration
    const sequential = [...reader.snapshots()];
    expect(sequential.length).toBe(snapshots.length);
    for (let i = 0; i < snapshots.length; i++) {
      expect((sequential[i] as SnapshotEntry).snapshot).toEqual(
        snapshots[i] as Snapshot,
      );
    }

    // Verify random access
    for (const expected of snapshots) {
      const entry = reader.snapshotNearestTo(expected.timestamp);
      expect(entry).not.toBeNull();
      expect(entry?.snapshot).toEqual(expected);
    }
  });

  test("throws for file without header", async () => {
    const p = tmpFile();
    // Write an empty file
    await Bun.write(p, new Uint8Array(0));
    expect(DumpReader.open(p)).rejects.toThrow("no header");
  });
});
