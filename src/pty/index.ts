/**
 * PTY management — run a child process in a pseudo-terminal.
 *
 * Supports two modes:
 * - **Passthrough** (default): transparent bridge between the local terminal and the child PTY.
 * - **Headless**: PTY output is only delivered via `onData`; no stdin/stdout/signal wiring.
 *
 * @module
 */

import { scanChunk } from "./signal-bridge.ts";

const textEncoder = new TextEncoder();

/** Options for creating a PTY session. */
export interface PtyOptions {
  /** The command and arguments to execute in the PTY. */
  command: string[];
  /** Additional environment variables merged on top of the inherited process.env. */
  env?: Record<string, string | undefined>;
  /** Terminal width. Defaults to `process.stdout.columns` in passthrough mode, 80 in headless. */
  cols?: number;
  /** Terminal height. Defaults to `process.stdout.rows` in passthrough mode, 24 in headless. */
  rows?: number;
  /**
   * Enable transparent stdin/stdout passthrough and signal handling.
   * When false, PTY output is only delivered via `onData`.
   * @default true
   */
  passthrough?: boolean;
  /** Called for each chunk of data received from the PTY. */
  onData?: (data: Uint8Array) => void;
  /** Called when the terminal is resized via SIGWINCH (passthrough mode only). */
  onResize?: (cols: number, rows: number) => void;
}

/** A handle to a running PTY session. */
export interface PtySession {
  /**
   * Write data directly to the PTY.
   *
   * Used for injecting input from external sources.
   * Unlike local stdin, this bypasses the signal bridge — bytes are
   * forwarded as-is to the PTY. No-op after the child process exits.
   *
   * @param data - Bytes or text to send to the PTY
   */
  write(data: Uint8Array | string): void;

  /**
   * Send a signal to the child process.
   *
   * Silently ignores ESRCH (process already exited).
   *
   * @param signal - The signal to send (default: SIGTERM)
   */
  kill(signal?: NodeJS.Signals): void;

  /** Promise that resolves with the child process exit code. */
  readonly exited: Promise<number>;
}

/**
 * Run a command in a PTY.
 *
 * In passthrough mode (default), stdin/stdout are transparently bridged and
 * SIGWINCH/SIGTERM are forwarded. In headless mode (`passthrough: false`),
 * only `onData` receives output and no local terminal wiring is performed.
 *
 * @param options - Configuration for the PTY session
 * @returns A session handle with `write()`, `kill()`, and `exited`
 */
export function runPty(options: PtyOptions): PtySession {
  const { command, env, onData, onResize, passthrough = true } = options;

  let disposed = false;
  const disposeCallbacks: (() => void)[] = [];

  // Terminal options must be passed inline (not a pre-created instance)
  // so that Bun sets up the controlling terminal correctly (bun#25779).
  const proc = Bun.spawn(command, {
    terminal: {
      cols: options.cols ?? (passthrough ? process.stdout.columns || 80 : 80),
      rows: options.rows ?? (passthrough ? process.stdout.rows || 24 : 24),
      data(_terminal: Bun.Terminal, data: Uint8Array) {
        if (passthrough) process.stdout.write(data);
        onData?.(data);
      },
    },
    env: {
      ...process.env,
      ...env,
      TERM: env?.TERM || process.env.TERM || "xterm-256color",
    },
  });

  const terminal = proc.terminal;
  if (!terminal) {
    proc.kill();
    throw new Error("Failed to create PTY terminal");
  }
  disposeCallbacks.push(() => terminal.close());

  if (passthrough) {
    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
      disposeCallbacks.push(() => process.stdin.setRawMode(false));
    }

    // POSIX ISIG bit in termios c_lflag
    const ISIG = 0x01;

    const onStdinData = (rawData: Buffer) => {
      if (terminal.localFlags & ISIG) {
        // Cooked mode: Bun.Terminal.write() bypasses line discipline
        // (bun#25779), so deliver signals manually and strip control
        // characters from the forwarded data.
        const { signals, data } = scanChunk(rawData);
        for (const signal of signals) safeKill(proc.pid, signal);
        for (const segment of data) terminal.write(segment);
      } else {
        // Raw mode: the child handles control characters itself
        // (e.g. Claude Code's "press again to exit" on Ctrl+C).
        terminal.write(rawData);
      }
    };
    process.stdin.on("data", onStdinData);
    disposeCallbacks.push(() => process.stdin.off("data", onStdinData));

    const onSigwinch = () => {
      const newCols = process.stdout.columns || 80;
      const newRows = process.stdout.rows || 24;
      terminal.resize(newCols, newRows);
      onResize?.(newCols, newRows);
    };
    process.on("SIGWINCH", onSigwinch);
    disposeCallbacks.push(() => process.off("SIGWINCH", onSigwinch));

    const onSigterm = () => {
      safeKill(proc.pid, "SIGTERM");
    };
    process.on("SIGTERM", onSigterm);
    disposeCallbacks.push(() => process.off("SIGTERM", onSigterm));
  }

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    for (const c of disposeCallbacks) c();
  };

  const write = crDelayed((bytes) => {
    if (!disposed) terminal.write(bytes);
  });

  return {
    write(data: Uint8Array | string) {
      if (disposed) return;
      write(data);
    },

    kill(signal: NodeJS.Signals = "SIGTERM") {
      safeKill(proc.pid, signal);
    },

    exited: proc.exited.finally(cleanup),
  };
}

const CR_BYTES = new Uint8Array([0x0d]);
const DEFAULT_CR_DELAY_MS = 10;

/**
 * Wrap a raw byte writer so that CR (`\r`) in string data is delivered as a
 * separate write after a short delay. TUI frameworks (e.g. Ink) may treat
 * text + CR arriving in a single chunk as pasted text, turning CR into a
 * literal newline instead of a submit action.
 *
 * - `Uint8Array` and strings without CR are forwarded immediately.
 * - Strings containing CR are split on CR boundaries; each CR is written
 *   after a delay to give the TUI time to process preceding text.
 * - All writes are sequenced through an internal queue to preserve order.
 *
 * @param write - The underlying byte writer
 * @returns A writer with the same signature plus an optional `delay` override
 */
function crDelayed(
  write: (bytes: Uint8Array) => void,
): (data: Uint8Array | string) => void {
  let queue: Promise<void> | undefined;

  const enqueue = (bytes: Uint8Array, ms = 0): void => {
    let prev = queue;
    queue = (async () => {
      await prev;
      prev = undefined;
      if (ms !== 0) await Bun.sleep(ms);
      write(bytes);
    })();
  };

  return (data: Uint8Array | string) => {
    const delay = DEFAULT_CR_DELAY_MS;
    if (typeof data === "string" && data.includes("\r")) {
      const parts = data.split("\r");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) enqueue(CR_BYTES, delay);
        if (parts[i]) enqueue(textEncoder.encode(parts[i]));
      }
    } else {
      enqueue(typeof data === "string" ? textEncoder.encode(data) : data);
    }
  };
}

/** Send a signal to a process, silently ignoring ESRCH (process already exited). */
function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && e.code === "ESRCH") return;
    throw e;
  }
}
