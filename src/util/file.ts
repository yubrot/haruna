/**
 * File utilities — glob expansion, content checksumming, and file watching.
 *
 * @module
 */

import { type FSWatcher, watch } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * Expand glob include/exclude patterns into deduplicated absolute file paths.
 *
 * @param includes - Glob patterns to include
 * @param cwd - Working directory for glob resolution
 * @param excludes - Glob patterns to exclude (matched against cwd-relative paths)
 * @returns Deduplicated absolute file paths
 */
export async function expandGlobs(
  includes: string[],
  cwd: string,
  excludes?: string[],
): Promise<string[]> {
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const pattern of includes) {
    const normalized = normalizePath(pattern, cwd);
    const glob = new Bun.Glob(normalized);
    for await (const filePath of glob.scan({ cwd, absolute: true })) {
      if (!seen.has(filePath)) {
        seen.add(filePath);
        matched.push(filePath);
      }
    }
  }

  if (!excludes?.length) return matched;

  const excludeGlobs = excludes.map(
    (pattern) => new Bun.Glob(normalizePath(pattern, cwd)),
  );
  return matched.filter((filePath) => {
    const rel = relative(cwd, filePath);
    return !excludeGlobs.some((glob) => glob.match(rel));
  });
}

/**
 * Normalize a path (or glob pattern) to a clean cwd-relative form.
 *
 * `Bun.Glob` accepts various relative forms (`./`, `../`, intermediate `..`)
 * but does not normalize them — the pattern and the target path must be in the
 * same form to match.  This function resolves the pattern against {@link cwd}
 * and converts it back to a relative path, ensuring a single canonical form
 * regardless of how the caller wrote the original pattern.
 */
function normalizePath(pattern: string, cwd: string): string {
  return relative(cwd, resolve(cwd, pattern));
}

/**
 * Compute a SHA-256 hex checksum over sorted file contents.
 *
 * Files that cannot be read (e.g. deleted between resolution and
 * checksumming) contribute only their path to the digest so the
 * resulting key still changes when the file set changes.
 *
 * @param filePaths - Absolute paths of files to hash
 * @returns Hex-encoded SHA-256 digest
 */
export async function computeChecksum(filePaths: string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const filePath of [...filePaths].sort()) {
    try {
      const content = await Bun.file(filePath).arrayBuffer();
      hasher.update(new Uint8Array(content));
    } catch {
      hasher.update(filePath);
    }
  }
  return hasher.digest("hex");
}

/**
 * Watches a set of file paths and invokes a callback when any changes.
 *
 * Supports incremental updates: calling {@link update} diffs the new path
 * set against the previous one and only adds/removes watchers as needed.
 */
export class FileWatch {
  private readonly onChange: () => void;
  private watchers: Map<string, FSWatcher> = new Map();

  /**
   * @param onChange - Callback invoked when any watched file changes
   */
  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /**
   * Replace the set of watched files.
   *
   * Closes watchers for removed paths and adds watchers for new paths.
   *
   * @param paths - Absolute file paths to watch
   */
  update(paths: string[]): void {
    const newSet = new Set(paths);

    // Remove watchers for paths no longer in the set
    for (const [path, watcher] of this.watchers) {
      if (!newSet.has(path)) {
        watcher.close();
        this.watchers.delete(path);
      }
    }

    // Add watchers for newly added paths
    for (const path of paths) {
      if (!this.watchers.has(path)) {
        try {
          const watcher = watch(path, () => {
            this.onChange();
          });
          watcher.on("error", () => {
            // File may have been deleted after watch started; silently remove
            this.watchers.delete(path);
          });
          this.watchers.set(path, watcher);
        } catch {
          // File does not exist or is inaccessible; skip silently
        }
      }
    }
  }

  /** Close all watchers. */
  close(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
