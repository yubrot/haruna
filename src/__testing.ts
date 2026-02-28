/**
 * Project-wide test utilities.
 *
 * @module
 */

import { afterEach, beforeEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Result of {@link useTempDir}. Provides access to the temporary directory
 * path and a helper for generating unique file paths inside it.
 */
export interface TempDir {
  /** Absolute path to the temporary directory. */
  readonly dir: string;
  /**
   * Generate a unique file path inside the temporary directory.
   *
   * @param prefix - Optional prefix for the file name
   * @returns An absolute path (the file is NOT created on disk)
   */
  tmpFile: (prefix?: string) => string;
}

/**
 * Create a temporary directory scoped to the current `describe` block.
 * The directory is created fresh before each test (`beforeEach`) and
 * removed after each test (`afterEach`).
 *
 * Must be called inside a `describe` block (or at the top level of a test
 * file).
 *
 * @param prefix - Identifier included in the directory name
 * @returns A {@link TempDir} with the directory path and a file-path factory
 */
export function useTempDir(prefix: string): TempDir {
  const dir = join(
    tmpdir(),
    `haruna-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    try {
      Bun.spawnSync(["rm", "-rf", dir]);
    } catch {
      // ignore
    }
  });

  return {
    dir,
    tmpFile(filePrefix?: string) {
      const name = [
        filePrefix ?? "tmp",
        Date.now().toString(36),
        Math.random().toString(36).slice(2),
      ].join("-");
      return join(dir, name);
    },
  };
}
