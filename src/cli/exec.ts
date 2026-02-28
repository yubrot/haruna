/**
 * Exec command — run a command in a PTY with event pipeline.
 *
 * @module
 */

import { resolve } from "node:path";
import { DumpChannel } from "../channel/dump.ts";
import { Gateway } from "../gateway.ts";
import { type PtySession, runPty } from "../pty/index.ts";
import { VirtualTerminal } from "../vt/index.ts";

/**
 * Run a command in a PTY with full event pipeline.
 *
 * @param command - The command and its arguments to execute
 * @returns The child process exit code
 */
export async function runExec(command: string[]): Promise<number> {
  let session: PtySession | null = null;

  const gateway = new Gateway({
    write: (bytes) => session?.write(bytes),
  });
  await gateway.replaceChannels([
    new DumpChannel({
      filePath: resolve(".haruna-dump", `${Date.now()}.dump`),
      command,
    }),
  ]);

  const vt = new VirtualTerminal({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    scrollback: 500,
    onChange: (snapshot) => gateway.update(snapshot),
  });

  session = runPty({
    command,
    onData: (data) => vt.write(data),
    onResize: (newCols, newRows) => vt.resize(newCols, newRows),
  });

  let exitCode = 1;
  try {
    exitCode = await session.exited;
    await vt.flush();
  } catch (e) {
    console.error(`haruna: ${e instanceof Error ? e.message : e}`);
  } finally {
    vt.dispose();
    await gateway.replaceChannels([]);
  }
  return exitCode;
}
