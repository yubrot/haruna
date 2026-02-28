import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useTempDir } from "../__testing.ts";
import { richTextToPlainText } from "../vt/snapshot.ts";
import { DumpReader, type SnapshotEntry } from "./reader.ts";
import { parseRecordScript, recordDump } from "./recorder.ts";

const { dir: testDir } = useTempDir("recorder-test");

describe("parseRecordScript", () => {
  test("parses valid YAML", () => {
    const yaml = `
command: ["echo", "hello"]
steps:
  - snapshot
`;
    const result = parseRecordScript(yaml);
    expect(result.command).toEqual(["echo", "hello"]);
    expect(result.steps).toEqual(["snapshot"]);
  });

  test("throws on invalid YAML content", () => {
    expect(() => parseRecordScript("command: 123\nsteps: []")).toThrow();
  });
});

describe("recordDump", () => {
  test("records a single snapshot from echo command", async () => {
    const dumpPath = join(testDir, "echo.dump");
    const script = parseRecordScript(`
command: ["echo", "hello world"]
cols: 80
rows: 24
steps:
  - wait: { stable: 200 }
  - snapshot
`);

    const count = await recordDump(script, dumpPath);
    expect(count).toBe(1);

    const reader = await DumpReader.open(dumpPath);
    expect(reader.header.command).toEqual(["echo", "hello world"]);

    const entries = [...reader.snapshots()];
    expect(entries.length).toBe(1);

    const snapshot = (entries[0] as SnapshotEntry).snapshot;
    expect(snapshot).toMatchObject({ timestamp: 0, cols: 80, rows: 24 });

    // The output should contain "hello world"
    const text = snapshot.lines.map(richTextToPlainText).join("\n");
    expect(text).toContain("hello world");
  });

  test("records multiple snapshots with sequential timestamps", async () => {
    const dumpPath = join(testDir, "multi.dump");
    const script = parseRecordScript(`
command: ["sh", "-c", "echo first; echo second; echo third"]
cols: 80
rows: 24
steps:
  - wait: { stable: 200 }
  - snapshot
  - snapshot
  - snapshot
`);

    const count = await recordDump(script, dumpPath);
    expect(count).toBe(3);

    const reader = await DumpReader.open(dumpPath);
    const entries = [...reader.snapshots()];
    expect(entries.length).toBe(3);

    expect(entries.map((e) => e.snapshot.timestamp)).toEqual([0, 1000, 2000]);
  });

  test("wait content matches regex in terminal output", async () => {
    const dumpPath = join(testDir, "wait-content.dump");
    const script = parseRecordScript(`
command: ["sh", "-c", "echo MARKER_LINE"]
cols: 80
rows: 24
steps:
  - wait: { content: "MARKER_LINE" }
  - snapshot
`);

    const count = await recordDump(script, dumpPath);
    expect(count).toBe(1);

    const reader = await DumpReader.open(dumpPath);
    const entries = [...reader.snapshots()];
    expect(entries.length).toBe(1);

    const text = (entries[0] as SnapshotEntry).snapshot.lines
      .map(richTextToPlainText)
      .join("\n");
    expect(text).toContain("MARKER_LINE");
  });

  test("wait stable waits for output to settle", async () => {
    const dumpPath = join(testDir, "wait-stable.dump");
    const script = parseRecordScript(`
command: ["sh", "-c", "echo done"]
cols: 80
rows: 24
steps:
  - wait: { stable: 100 }
  - snapshot
`);

    const count = await recordDump(script, dumpPath);
    expect(count).toBe(1);

    const reader = await DumpReader.open(dumpPath);
    const entries = [...reader.snapshots()];
    expect(entries.length).toBe(1);
  });

  test("input step sends data to child process", async () => {
    const dumpPath = join(testDir, "input.dump");
    const script = parseRecordScript(`
command: ["sh", "-c", "read -r line; echo got:$line"]
cols: 80
rows: 24
steps:
  - input: "test-data\\n"
  - wait: { content: "got:test-data" }
  - snapshot
`);

    const count = await recordDump(script, dumpPath);
    expect(count).toBe(1);

    const reader = await DumpReader.open(dumpPath);
    const entries = [...reader.snapshots()];
    expect(entries.length).toBe(1);

    const text = (entries[0] as SnapshotEntry).snapshot.lines
      .map(richTextToPlainText)
      .join("\n");
    expect(text).toContain("got:test-data");
  });

  test("applies specified cols and rows to snapshot", async () => {
    const dumpPath = join(testDir, "size.dump");
    const script = parseRecordScript(`
command: ["echo", "sized"]
cols: 100
rows: 30
steps:
  - wait: { stable: 200 }
  - snapshot
`);

    const count = await recordDump(script, dumpPath);
    expect(count).toBe(1);

    const reader = await DumpReader.open(dumpPath);
    const entries = [...reader.snapshots()];
    expect((entries[0] as SnapshotEntry).snapshot).toMatchObject({
      cols: 100,
      rows: 30,
    });
  });

  test("throws on wait timeout", async () => {
    const dumpPath = join(testDir, "timeout.dump");
    const script = parseRecordScript(`
command: ["echo", "hello"]
steps:
  - wait: { content: "NEVER_APPEARS", timeout: 200, poll: 50 }
  - snapshot
`);

    await expect(recordDump(script, dumpPath)).rejects.toThrow(
      /Timed out waiting for content/,
    );
  });
});
