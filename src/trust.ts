/**
 * Trust store for config file directories.
 *
 * Stores trusted directory paths as files under
 * `$XDG_STATE_HOME/haruna/trusted-dirs/` (default `~/.local/state/haruna/trusted-dirs/`).
 * Each file is named by the SHA256 hash of the resolved directory path,
 * and its content is the original path — making add/remove atomic at the
 * filesystem level.
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Check whether the given directory is trusted.
 *
 * @param dir - Directory path to check
 * @returns `true` if the directory has been explicitly trusted
 */
export function isTrusted(dir: string): boolean {
  const storePath = join(trustStoreDir(), hashDir(dir));
  return existsSync(storePath);
}

/**
 * Add a directory to the trusted set.
 *
 * Creates the trust store directory if it does not exist.
 * Re-adding an already-trusted directory is a no-op.
 *
 * @param dir - Directory path to trust
 */
export async function addTrusted(dir: string): Promise<void> {
  const storeDir = trustStoreDir();
  mkdirSync(storeDir, { recursive: true });
  await Bun.write(join(storeDir, hashDir(dir)), resolve(dir));
}

/**
 * Remove a directory from the trusted set.
 *
 * Removing a directory that is not trusted is a no-op.
 *
 * @param dir - Directory path to revoke trust for
 */
export function removeTrusted(dir: string): void {
  const storePath = join(trustStoreDir(), hashDir(dir));
  try {
    unlinkSync(storePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Return all currently trusted directory paths.
 *
 * @returns Array of resolved directory paths
 */
export async function listTrusted(): Promise<string[]> {
  const storeDir = trustStoreDir();
  if (!existsSync(storeDir)) return [];

  const entries = readdirSync(storeDir);
  const paths: string[] = [];
  for (const entry of entries) {
    const content = await Bun.file(join(storeDir, entry)).text();
    paths.push(content);
  }
  return paths;
}

function trustStoreDir(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "haruna", "trusted-dirs");
}

function hashDir(dir: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(resolve(dir));
  return hasher.digest("hex");
}
