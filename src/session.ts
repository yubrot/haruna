/**
 * A running PTY session with live scene/channel orchestration.
 *
 * {@link Session.create} assembles the full pipeline (PTY → VT → Relay)
 * and keeps scene/channel configuration in sync across hot-reloads.
 *
 * @module
 */

import type { Config, InitOutput } from "./config.ts";
import { type PtyHandle, runPty } from "./pty/index.ts";
import { Relay, RelayConfigurator } from "./relay.ts";
import { VirtualTerminal } from "./vt/index.ts";

/** Options for creating a {@link Session}. */
export interface SessionOptions {
  /** Configuration (may be unresolved — init is run automatically if configured). */
  config: Config;
  /** Arguments passed to the init command (default: `[]`). */
  initArgs?: string[];
  /** Extra arguments passed to {@link Config.buildCommand} (default: `[]`). */
  commandArgs?: string[];
  /** Terminal width. */
  cols: number;
  /** Terminal height. */
  rows: number;
  /** Wire local stdin/stdout and SIGWINCH to the PTY. */
  passthrough: boolean;
  /** Operating mode — forwarded to scene/channel factories. */
  mode: "exec";
}

/**
 * A fully assembled PTY + VirtualTerminal + Relay unit.
 *
 * Manages scene/channel reconciliation via {@link reapplyBaseConfig} and
 * owns the full lifecycle of its resources — including the PTY process —
 * via {@link dispose}.
 */
export class Session {
  /** The bidirectional relay between VT snapshots and channels. */
  readonly relay: Relay;
  /** Handle to the PTY child process. */
  readonly ptyHandle: PtyHandle;

  private _config: Config;
  private readonly initOutput: InitOutput | null;
  private readonly vt: VirtualTerminal;
  private readonly configurator: RelayConfigurator;
  private disposed = false;

  /** The current configuration. init is applied. */
  get config(): Config {
    return this._config;
  }

  private constructor(
    relay: Relay,
    ptyHandle: PtyHandle,
    vt: VirtualTerminal,
    config: Config,
    initOutput: InitOutput | null,
    configurator: RelayConfigurator,
  ) {
    this.relay = relay;
    this.ptyHandle = ptyHandle;
    this.vt = vt;
    this._config = config;
    this.initOutput = initOutput;
    this.configurator = configurator;
  }

  /**
   * Create a new Session with a running PTY, VirtualTerminal, and Relay.
   *
   * When an init command is configured, it is executed first and the
   * resulting overrides are applied to the config. The initial
   * configuration is then applied to the relay before returning.
   * On error during setup, the PTY is killed and all resources are
   * cleaned up.
   *
   * @param options - Session options
   * @returns A fully initialized Session
   */
  static async create(options: SessionOptions): Promise<Session> {
    let config = options.config;

    let initOutput: InitOutput | null = null;
    if (config.init) {
      initOutput = await config.runInit(options.initArgs ?? []);
      config = config.applyInitOutput(initOutput);
    }

    const command = config.buildCommand(options.commandArgs ?? []);

    let ptyHandle: PtyHandle | undefined;

    const relay = new Relay({ write: (bytes) => ptyHandle?.write(bytes) });
    const configurator = new RelayConfigurator(relay, { mode: options.mode, command });

    const vt = new VirtualTerminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: config.terminal.scrollback,
      debounceMs: config.terminal.debounceMs,
      maxIntervalMs: config.terminal.maxIntervalMs,
      onChange: (snapshot) => relay.update(snapshot),
    });

    try {
      ptyHandle = runPty({
        command,
        cols: options.cols,
        rows: options.rows,
        passthrough: options.passthrough,
        onData: (data) => vt.write(data),
        onResize: options.passthrough
          ? (newCols, newRows) => vt.resize(newCols, newRows)
          : undefined,
      });

      await configurator.apply(config);
    } catch (e) {
      ptyHandle?.kill();
      await ptyHandle?.exited.catch(() => {});
      await relay.dispose().catch(() => {});
      vt.dispose();
      throw e;
    }

    return new Session(relay, ptyHandle, vt, config, initOutput, configurator);
  }

  /**
   * Reload configuration from disk and re-apply to the relay.
   *
   * Re-reads the config file and re-applies the stored init output
   * (if any) before applying.
   */
  async reloadConfig(): Promise<void> {
    return this.reapplyBaseConfig(await this._config.reload());
  }

  /**
   * Re-apply a fresh base configuration to the relay.
   *
   * The stored init output (if any) is merged before applying.
   * Use this when the caller has already reloaded the config.
   *
   * @param baseConfig - Freshly loaded base configuration
   */
  async reapplyBaseConfig(baseConfig: Config): Promise<void> {
    const resolved = this.initOutput ? baseConfig.applyInitOutput(this.initOutput) : baseConfig;
    this._config = resolved;
    await this.configurator.apply(resolved);
  }

  /**
   * Kill the PTY process and clean up all session resources.
   *
   * Idempotent — safe to call multiple times.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.ptyHandle.kill();
    await this.ptyHandle.exited.catch(() => {});
    await this.vt.flush();
    await this.relay.dispose();
    this.vt.dispose();
  }
}
