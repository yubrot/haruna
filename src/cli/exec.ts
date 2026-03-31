/**
 * Exec command — run a command in a PTY with event pipeline.
 *
 * @module
 */

import { Attacher } from "../attacher.ts";
import type { Config } from "../config.ts";
import { type PtyHandle, runPty } from "../pty/index.ts";
import { Relay } from "../relay.ts";
import { FileWatch } from "../util/file.ts";
import { VirtualTerminal } from "../vt/index.ts";

/**
 * Run a command in a PTY with full event pipeline.
 *
 * @param command - The command and its arguments to execute
 * @param config - Resolved configuration
 * @returns The child process exit code
 */
export async function runExec(command: string[], config: Config): Promise<number> {
  let ptyHandle: PtyHandle | null = null;

  const relay = new Relay({ write: (bytes) => ptyHandle?.write(bytes) });
  const attacher = new Attacher(relay, {
    sceneConfig: { _mode: "exec", _command: command },
    channelConfig: { _mode: "exec", _command: command },
  });

  const fileWatch = new FileWatch(async () => {
    try {
      const reloaded = await config.reload();
      await attacher.apply(reloaded);
      fileWatch.update(await reloaded.fileWatchTargets());
    } catch (e) {
      console.error(`[haruna] config reload failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  await attacher.apply(config);
  fileWatch.update(await config.fileWatchTargets());

  const size = process.stdout.isTTY
    ? { cols: process.stdout.columns, rows: process.stdout.rows }
    : { cols: config.terminal.cols, rows: config.terminal.rows };

  const vt = new VirtualTerminal({
    ...size,
    scrollback: config.terminal.scrollback,
    debounceMs: config.terminal.debounceMs,
    maxIntervalMs: config.terminal.maxIntervalMs,
    onChange: (snapshot) => relay.update(snapshot),
  });

  ptyHandle = runPty({
    command,
    ...size,
    onData: (data) => vt.write(data),
    onResize: (newCols, newRows) => vt.resize(newCols, newRows),
  });

  let exitCode = 1;
  try {
    exitCode = await ptyHandle.exited;
    await vt.flush();
  } catch (e) {
    console.error(`[haruna] ${e instanceof Error ? e.message : e}`);
  } finally {
    fileWatch.close();
    await attacher.apply(null);
    vt.dispose();
  }
  return exitCode;
}
