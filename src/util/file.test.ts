import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTempDir } from "../__testing.ts";
import { computeChecksum, expandGlobs, FileWatch } from "./file.ts";

describe("expandGlobs", () => {
  const { dir } = useTempDir("glob-test");

  test("returns empty array for empty includes", async () => {
    const result = await expandGlobs([], dir);
    expect(result).toEqual([]);
  });

  test("matches files by glob pattern", async () => {
    writeFileSync(join(dir, "a.ts"), "a");
    writeFileSync(join(dir, "b.ts"), "b");

    const result = await expandGlobs(["*.ts"], dir);
    expect(result).toHaveLength(2);
  });

  test("deduplicates files matched by multiple patterns", async () => {
    writeFileSync(join(dir, "scene.ts"), "x");

    const result = await expandGlobs(["*.ts", "scene.ts"], dir);
    expect(result).toHaveLength(1);
  });

  test("resolves from subdirectories", async () => {
    const sub = join(dir, "scenes");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "nested.ts"), "x");

    const result = await expandGlobs(["scenes/*.ts"], dir);
    expect(result).toHaveLength(1);
  });

  test("resolves include pattern with ./ prefix", async () => {
    writeFileSync(join(dir, "a.ts"), "a");

    const result = await expandGlobs(["./a.ts"], dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(dir, "a.ts"));
  });

  test("resolves include pattern with absolute path", async () => {
    writeFileSync(join(dir, "a.ts"), "a");

    const result = await expandGlobs([join(dir, "a.ts")], dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(dir, "a.ts"));
  });

  test("resolves include pattern with absolute glob", async () => {
    writeFileSync(join(dir, "a.ts"), "a");
    writeFileSync(join(dir, "b.ts"), "b");

    const result = await expandGlobs([`${dir}/*.ts`], dir);
    expect(result).toHaveLength(2);
  });

  test("resolves include pattern with ././ prefix", async () => {
    writeFileSync(join(dir, "a.ts"), "a");

    const result = await expandGlobs(["././a.ts"], dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(dir, "a.ts"));
  });

  test("resolves include pattern with ../ relative path", async () => {
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "a");

    const result = await expandGlobs(["../a.ts"], sub);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(dir, "a.ts"));
  });

  test("resolves include pattern with intermediate ..", async () => {
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "a");

    const result = await expandGlobs(["sub/../a.ts"], dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(dir, "a.ts"));
  });

  test("applies exclude patterns", async () => {
    writeFileSync(join(dir, "scene.ts"), "x");
    writeFileSync(join(dir, "scene.test.ts"), "x");

    const result = await expandGlobs(["*.ts"], dir, ["*.test.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("scene.ts");
    expect(result[0]).not.toContain(".test.ts");
  });

  test("applies exclude pattern with ./ prefix", async () => {
    writeFileSync(join(dir, "a.ts"), "a");
    writeFileSync(join(dir, "b.ts"), "b");

    const result = await expandGlobs(["*.ts"], dir, ["./a.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(dir, "b.ts"));
  });

  test("applies exclude pattern with absolute path", async () => {
    writeFileSync(join(dir, "a.ts"), "a");
    writeFileSync(join(dir, "b.ts"), "b");

    const result = await expandGlobs(["*.ts"], dir, [join(dir, "a.ts")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(dir, "b.ts"));
  });
});

describe("computeChecksum", () => {
  const { dir } = useTempDir("checksum-test");

  test("returns consistent checksum for same content", async () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "content");

    const c1 = await computeChecksum([file]);
    const c2 = await computeChecksum([file]);
    expect(c1).toBe(c2);
  });

  test("checksum changes when file content changes", async () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "v1");
    const c1 = await computeChecksum([file]);

    writeFileSync(file, "v2");
    const c2 = await computeChecksum([file]);
    expect(c1).not.toBe(c2);
  });

  test("checksum is independent of file path order", async () => {
    const fileA = join(dir, "a.ts");
    const fileB = join(dir, "b.ts");
    writeFileSync(fileA, "aaa");
    writeFileSync(fileB, "bbb");

    const c1 = await computeChecksum([fileA, fileB]);
    const c2 = await computeChecksum([fileB, fileA]);
    expect(c1).toBe(c2);
  });

  test("empty file list returns a consistent checksum", async () => {
    const c1 = await computeChecksum([]);
    const c2 = await computeChecksum([]);
    expect(c1).toBe(c2);
  });

  test("returns a checksum even when a file is missing", async () => {
    const file = join(dir, "exists.ts");
    writeFileSync(file, "content");

    const c = await computeChecksum([file, join(dir, "missing.ts")]);
    expect(c).toBeString();
    expect(c).toHaveLength(64); // SHA-256 hex
  });
});

/**
 * Poll a predicate until it returns `true` or the timeout expires.
 *
 * @param predicate - Condition to wait for
 * @param timeoutMs - Maximum wait time in milliseconds
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(50);
  }
}

/**
 * Assert that a predicate stays `false` for a given duration.
 *
 * @param predicate - Condition that should remain false
 * @param durationMs - How long to observe
 */
async function expectNotCalled(
  predicate: () => boolean,
  durationMs = 300,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    if (predicate()) throw new Error("predicate became true unexpectedly");
    await Bun.sleep(50);
  }
}

describe("FileWatch", () => {
  const { dir } = useTempDir("fw-test");
  const watches: FileWatch[] = [];

  afterEach(() => {
    for (const w of watches) w.close();
    watches.length = 0;
  });

  test("invokes callback when a watched file changes", async () => {
    const file = join(dir, "test.txt");
    writeFileSync(file, "initial");

    let called = false;
    const fw = new FileWatch(() => {
      called = true;
    });
    watches.push(fw);

    fw.update([file]);
    writeFileSync(file, "changed");

    await waitFor(() => called);
    expect(called).toBe(true);
  });

  test("stops watching removed paths on update", async () => {
    const fileA = join(dir, "a.txt");
    const fileB = join(dir, "b.txt");
    writeFileSync(fileA, "a");
    writeFileSync(fileB, "b");

    let callCount = 0;
    const fw = new FileWatch(() => {
      callCount++;
    });
    watches.push(fw);

    fw.update([fileA, fileB]);
    // Remove fileA from watch set
    fw.update([fileB]);

    // Verify writing to the removed file does not trigger callback.
    // Skipped on macOS: Bun's fs.watch has a bug where writing to a file
    // whose watcher was closed corrupts sibling watchers.
    // https://github.com/oven-sh/bun/issues/18919
    if (process.platform !== "darwin") {
      writeFileSync(fileA, "a-changed");
      await expectNotCalled(() => callCount > 0);
    }

    // Modify fileB — retained watcher should still trigger callback
    writeFileSync(fileB, "b-changed");
    await waitFor(() => callCount > 0);
    expect(callCount).toBeGreaterThan(0);
  });

  test("close stops all watchers", async () => {
    const file = join(dir, "test.txt");
    writeFileSync(file, "initial");

    let called = false;
    const fw = new FileWatch(() => {
      called = true;
    });
    watches.push(fw);

    fw.update([file]);
    fw.close();

    writeFileSync(file, "changed");
    await expectNotCalled(() => called);
    expect(called).toBe(false);
  });

  test("update with empty array clears all watchers", async () => {
    const file = join(dir, "test.txt");
    writeFileSync(file, "initial");

    let called = false;
    const fw = new FileWatch(() => {
      called = true;
    });
    watches.push(fw);

    fw.update([file]);
    fw.update([]);

    writeFileSync(file, "changed");
    await expectNotCalled(() => called);
    expect(called).toBe(false);
  });
});
