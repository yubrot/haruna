import { describe, expect, test } from "bun:test";
import { useTempDir } from "../__testing.ts";
import { snapshot } from "../vt/__testing.ts";
import { decodeFrame } from "./frame.ts";
import { DumpWriter } from "./writer.ts";

async function readRecords(
  path: string,
): Promise<{ type: string; timestamp: number }[]> {
  const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
  const records: { type: string; timestamp: number }[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const result = decodeFrame(buf, offset);
    if (!result) break;
    records.push({
      type: result.frame.type,
      timestamp: result.frame.timestamp,
    });
    offset = result.nextOffset;
  }
  return records;
}

describe("DumpWriter", () => {
  const { tmpFile } = useTempDir("writer-test");

  test("writes header as first record", async () => {
    const p = tmpFile();
    const w = new DumpWriter(p, { command: ["test"] });
    await w.end();

    const records = await readRecords(p);
    expect(records).toMatchObject([{ type: "header" }]);
  });

  test("first snapshot is always a keyframe", async () => {
    const p = tmpFile();
    const w = new DumpWriter(p, { command: ["test"] });
    w.write(snapshot(["first"]));
    await w.end();

    const records = await readRecords(p);
    expect(records).toMatchObject([{ type: "header" }, { type: "keyframe" }]);
  });

  test("subsequent small changes produce delta records", async () => {
    const p = tmpFile();
    const w = new DumpWriter(p, { command: ["test"] });

    const now = Date.now();
    const s1 = snapshot(["hello"], { timestamp: now });
    const s2 = snapshot(["world"], { timestamp: now + 100 });
    const s3 = snapshot(["test!"], { timestamp: now + 200 });

    w.write(s1);
    w.write(s2);
    w.write(s3);
    await w.end();

    const records = await readRecords(p);
    expect(records).toMatchObject([
      { type: "header" },
      { type: "keyframe" },
      { type: "delta" },
      { type: "delta" },
    ]);
  });

  test("keyframe inserted after time threshold", async () => {
    const p = tmpFile();
    const w = new DumpWriter(
      p,
      { command: ["test"] },
      { keyframeIntervalMs: 1000 },
    );

    const now = Date.now();
    w.write(snapshot(["a"], { timestamp: now }));
    w.write(snapshot(["b"], { timestamp: now + 500 }));
    // Jump past the 1000ms threshold
    w.write(snapshot(["c"], { timestamp: now + 1500 }));
    await w.end();

    const records = await readRecords(p);
    // header + keyframe + delta + keyframe (due to time)
    expect(records).toMatchObject([
      { type: "header" },
      { type: "keyframe" },
      { type: "delta" },
      { type: "keyframe" },
    ]);
  });

  test("keyframe inserted when cumulative delta size exceeds ratio", async () => {
    const p = tmpFile();
    // Set a very low size ratio to trigger easily
    const w = new DumpWriter(
      p,
      { command: ["test"] },
      {
        keyframeIntervalMs: 999999,
        keyframeSizeRatio: 0.1,
      },
    );

    const now = Date.now();
    // First snapshot — keyframe (small)
    w.write(snapshot(["x"], { timestamp: now }));

    // Write many deltas with large content to exceed the ratio
    for (let i = 0; i < 50; i++) {
      w.write(
        snapshot([`${"A".repeat(200)}-${i}`], {
          timestamp: now + i + 1,
        }),
      );
    }
    await w.end();

    const records = await readRecords(p);
    // Should have at least one additional keyframe besides the first
    const keyframeCount = records.filter((r) => r.type === "keyframe").length;
    expect(keyframeCount).toBeGreaterThan(1);
  });
});
