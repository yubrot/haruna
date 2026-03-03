import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addTrusted, isTrusted, listTrusted, removeTrusted } from "./trust.ts";

describe("trust store", () => {
  let originalXdgStateHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalXdgStateHome = process.env.XDG_STATE_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "haruna-trust-test-"));
    process.env.XDG_STATE_HOME = tempDir;
  });

  afterEach(() => {
    if (originalXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalXdgStateHome;
    }
  });

  test("isTrusted returns false for untrusted directory", () => {
    expect(isTrusted("/some/untrusted/path")).toBe(false);
  });

  test("isTrusted returns false when store directory does not exist", () => {
    process.env.XDG_STATE_HOME = join(tempDir, "nonexistent");
    expect(isTrusted("/any/path")).toBe(false);
  });

  test("addTrusted makes isTrusted return true", async () => {
    const dir = "/home/user/project";
    expect(isTrusted(dir)).toBe(false);
    await addTrusted(dir);
    expect(isTrusted(dir)).toBe(true);
  });

  test("addTrusted is idempotent", async () => {
    const dir = "/home/user/project";
    await addTrusted(dir);
    await addTrusted(dir);
    expect(isTrusted(dir)).toBe(true);
  });

  test("removeTrusted revokes trust", async () => {
    const dir = "/home/user/project";
    await addTrusted(dir);
    expect(isTrusted(dir)).toBe(true);
    removeTrusted(dir);
    expect(isTrusted(dir)).toBe(false);
  });

  test("removeTrusted is a no-op for untrusted directory", () => {
    expect(() => removeTrusted("/not/trusted")).not.toThrow();
  });

  test("listTrusted returns all trusted paths", async () => {
    await addTrusted("/home/user/project-a");
    await addTrusted("/home/user/project-b");
    const list = await listTrusted();
    expect(list).toContain(resolve("/home/user/project-a"));
    expect(list).toContain(resolve("/home/user/project-b"));
    expect(list).toHaveLength(2);
  });

  test("listTrusted returns empty array when store does not exist", async () => {
    process.env.XDG_STATE_HOME = join(tempDir, "nonexistent");
    expect(await listTrusted()).toEqual([]);
  });

  test("path normalization: trailing slash does not affect identity", async () => {
    await addTrusted("/home/user/project/");
    expect(isTrusted("/home/user/project")).toBe(true);
    expect(isTrusted("/home/user/project/")).toBe(true);
  });

  test("store files are created under XDG_STATE_HOME", async () => {
    await addTrusted("/home/user/project");
    const storeDir = join(tempDir, "haruna", "trusted-dirs");
    expect(existsSync(storeDir)).toBe(true);
  });
});
