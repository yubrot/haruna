/**
 * Trust command — manage trusted config directories.
 *
 * Also provides {@link ensureTrusted} used by config loading to gate
 * untrusted directories.
 *
 * @module
 */

import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { addTrusted, isTrusted, listTrusted, removeTrusted } from "../trust.ts";

/**
 * Run the `haruna trust` subcommand.
 *
 * @param dir - Target directory (defaults to cwd)
 * @param opts - Command options
 * @returns Exit code
 */
export async function runTrust(
  dir: string | undefined,
  opts: { revoke?: true; list?: true },
): Promise<number> {
  if (opts.list) {
    const dirs = await listTrusted();
    for (const d of dirs) console.log(d);
    return 0;
  }

  const targetDir = resolve(dir ?? process.cwd());
  if (opts.revoke) {
    removeTrusted(targetDir);
    console.error(`[haruna] Revoked trust for ${targetDir}`);
  } else {
    await addTrusted(targetDir);
    console.error(`[haruna] Trusted ${targetDir}`);
  }
  return 0;
}

/**
 * Ensure the directory containing the config file is trusted before loading.
 *
 * Skipped when the `CI` environment variable is set. In non-TTY environments,
 * prints an error and exits. In TTY environments, prompts the user
 * interactively.
 *
 * @param dir - The directory to check trust for
 */
export async function ensureTrusted(dir: string): Promise<void> {
  if (process.env.CI) return;
  if (isTrusted(dir)) return;

  if (process.stdin.isTTY) {
    const answer = await promptTrust(dir);
    if (answer) {
      await addTrusted(dir);
      return;
    }
  }

  console.error(
    `[haruna] Config directory is not trusted: ${dir}\n` +
      "Run `haruna trust` in that directory, or set CI=true to skip the check.",
  );
  process.exit(1);
}

function promptTrust(dir: string): Promise<boolean> {
  return new Promise((res) => {
    // Open /dev/tty directly instead of using process.stdin so that
    // readline does not pause/corrupt stdin state for the later PTY session.
    const ttyInput = createReadStream("/dev/tty");
    const rl = createInterface({ input: ttyInput, output: process.stderr });
    rl.question(`[haruna] Trust config directory ${dir}? [y/N] `, (answer) => {
      rl.close();
      ttyInput.destroy();
      res(answer.trim().toLowerCase() === "y");
    });
  });
}
