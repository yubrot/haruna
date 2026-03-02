/**
 * PTY management — run a child process in a pseudo-terminal.
 *
 * Supports two modes:
 * - **Passthrough** (default): transparent bridge between the local terminal and the child PTY.
 * - **Headless**: PTY output is only delivered via `onData`; no stdin/stdout/signal wiring.
 *
 * @module
 */

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
   * Used for injecting input from external sources (e.g. Channels).
   * Bytes are forwarded as-is to the PTY. No-op after the child process exits.
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
  // so that Bun sets up the controlling terminal correctly.
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

    const onStdinData = (rawData: Buffer) => {
      terminal.write(rawData);
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

  return {
    write(data: Uint8Array | string) {
      if (disposed) return;
      terminal.write(typeof data === "string" ? new TextEncoder().encode(data) : data);
    },

    kill(signal: NodeJS.Signals = "SIGTERM") {
      safeKill(proc.pid, signal);
    },

    exited: proc.exited.finally(cleanup),
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
