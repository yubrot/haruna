/**
 * Exec command — run a command in a PTY with event pipeline.
 *
 * @module
 */

import type { Config } from "../config.ts";
import { Session } from "../session.ts";
import { FileWatch } from "../util/file.ts";

/**
 * Run a command in a PTY with full event pipeline.
 *
 * @param cliArgs - Extra arguments from the CLI (appended to config command, or used as fallback)
 * @param config - Base configuration (before init resolution)
 * @returns The child process exit code
 */
export async function runExec(cliArgs: string[], config: Config): Promise<number> {
  const session = await Session.create({
    config,
    commandArgs: cliArgs,
    cols: process.stdout.isTTY ? process.stdout.columns : config.terminal.cols,
    rows: process.stdout.isTTY ? process.stdout.rows : config.terminal.rows,
    passthrough: true,
    mode: "exec",
  });

  const fileWatch = new FileWatch(async () => {
    try {
      await session.reloadConfig();
      fileWatch.update(await session.config.fileWatchTargets());
    } catch (e) {
      console.error(`[haruna] config reload failed: ${e instanceof Error ? e.message : e}`);
    }
  });
  fileWatch.update(await session.config.fileWatchTargets());

  let exitCode = 1;
  try {
    exitCode = await session.ptyHandle.exited;
  } catch (e) {
    console.error(`[haruna] ${e instanceof Error ? e.message : e}`);
  } finally {
    fileWatch.close();
    await session.dispose();
  }
  return exitCode;
}
