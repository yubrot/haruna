/**
 * Exec command — run a command in a PTY with event pipeline.
 *
 * @module
 */

import { Attacher } from "../attacher.ts";
import { Config } from "../config.ts";
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
  const cwd = process.cwd();
  const config = await Config.load(cwd);

  let session: PtySession | null = null;

  const gateway = new Gateway({
    write: (bytes) => session?.write(bytes),
  });
  const attacher = new Attacher(gateway, {
    config,
    cwd,
    sceneConfig: { _mode: "exec", _command: command },
    channelConfig: { _mode: "exec", _command: command },
  });

  await attacher.start();

  const size = process.stdout.isTTY
    ? { cols: process.stdout.columns, rows: process.stdout.rows }
    : { cols: config.terminal.cols, rows: config.terminal.rows };

  const vt = new VirtualTerminal({
    ...size,
    scrollback: config.terminal.scrollback,
    debounceMs: config.terminal.debounceMs,
    maxIntervalMs: config.terminal.maxIntervalMs,
    onChange: (snapshot) => gateway.update(snapshot),
  });

  session = runPty({
    command,
    ...size,
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
    await attacher.stop();
    vt.dispose();
  }
  return exitCode;
}
