/**
 * Multiplexer — dynamically manages multiple sessions for multiplexing mode.
 *
 * Implements the {@link SessionManager} interface. Gateways call
 * {@link request} and {@link detach} to create, attach to, and detach
 * from sessions on demand.
 *
 * @module
 */

import type { Channel } from "./channel/interface.ts";
import type { Config } from "./config.ts";
import type { Gateway, SessionInfo, SessionManager } from "./gateway/interface.ts";
import { loadGateways } from "./gateway/loader.ts";
import { Session } from "./session.ts";

/** Options for creating a {@link Multiplexer}. */
export interface MultiplexerOptions {
  /** The base configuration used to derive per-session configs. */
  config: Config;
}

/** Lifecycle phase of a session slot. */
type SessionSlot =
  | { phase: "creating"; ready: Promise<void> }
  | { phase: "alive"; session: Session }
  | { phase: "destroying"; done: Promise<void> };

/**
 * Manages multiple sessions dynamically for multiplexing mode.
 *
 * Each session is identified by a string ID issued by a Gateway.
 * Sessions are created on first {@link request} and destroyed when
 * the underlying PTY process exits.
 */
export class Multiplexer implements SessionManager {
  private slots: Map<string, SessionSlot> = new Map();
  private gateways: Set<Gateway> = new Set();
  private onCreatedCallbacks: Set<(info: SessionInfo) => void> = new Set();
  private onDestroyedCallbacks: Set<(info: SessionInfo) => void> = new Set();
  private _config: Config;

  /** The current configuration. Potentially init is unapplied. */
  get config(): Config {
    return this._config;
  }

  constructor(options: MultiplexerOptions) {
    this._config = options.config;
  }

  /**
   * Request a session by ID and attach a channel to it.
   *
   * If the session does not exist, it is created (init -> start -> attach).
   * If it already exists, the channel is attached to the running session.
   * Concurrent requests for the same ID are serialized; an in-progress
   * destroy is awaited before creating a new session.
   *
   * @param id - Session ID issued by the Gateway
   * @param channel - Channel to attach to the session
   */
  async request(id: string, channel: Channel): Promise<void> {
    const slot = this.slots.get(id);

    switch (slot?.phase) {
      case "destroying":
        await slot.done;
        return await this.request(id, channel);
      case "alive":
        await slot.session.relay.addChannels([channel]);
        return;
      case "creating":
        await slot.ready;
        return await this.request(id, channel);
    }

    // No slot — create a new session
    const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
    // Prevent unhandled rejection when no concurrent waiter exists
    ready.catch(() => {});
    this.slots.set(id, { phase: "creating", ready });

    try {
      const hash = new Bun.CryptoHasher("sha256").update(id).digest("hex");
      const session = await Session.create({
        config: this._config,
        initArgs: [id, hash],
        cols: this._config.terminal.cols,
        rows: this._config.terminal.rows,
        passthrough: false,
        mode: "mux",
      });

      this.slots.set(id, { phase: "alive", session });
      invokeCallbacks(this.onCreatedCallbacks, { id });

      resolve();
      await session.relay.addChannels([channel]);

      // Register PTY exit handler after attach completes so that
      // short-lived processes don't transition to "destroying"
      // before the first channel is attached.
      void session.ptyHandle.exited.then(() => {
        const done = session
          .dispose()
          .catch((e) => {
            console.error(
              `[haruna] session ${id} cleanup failed: ${e instanceof Error ? e.message : e}`,
            );
          })
          .finally(() => {
            this.slots.delete(id);
            invokeCallbacks(this.onDestroyedCallbacks, { id });
          });
        this.slots.set(id, { phase: "destroying", done });
      });
    } catch (e) {
      this.slots.delete(id);
      reject(e);
      throw e;
    }
  }

  /**
   * Detach a channel from a session.
   *
   * @param id - Session ID to detach from
   * @param channel - Channel to detach
   */
  detach(id: string, channel: Channel): void {
    const slot = this.slots.get(id);
    if (slot?.phase !== "alive") return;
    void slot.session.relay.removeChannels([channel]);
  }

  /**
   * List all active sessions.
   *
   * @returns Snapshot of currently running sessions
   */
  list(): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const [id, slot] of this.slots) {
      if (slot.phase === "alive") result.push({ id });
    }
    return result;
  }

  /**
   * Register a callback invoked when a new session is created.
   *
   * @param callback - Called with the session info on creation
   * @returns An unsubscribe function
   */
  onSessionCreated(callback: (info: SessionInfo) => void): () => void {
    this.onCreatedCallbacks.add(callback);
    return () => this.onCreatedCallbacks.delete(callback);
  }

  /**
   * Register a callback invoked when a session is destroyed.
   *
   * @param callback - Called with the session info on destruction
   * @returns An unsubscribe function
   */
  onSessionDestroyed(callback: (info: SessionInfo) => void): () => void {
    this.onDestroyedCallbacks.add(callback);
    return () => this.onDestroyedCallbacks.delete(callback);
  }

  /**
   * Add gateways to the multiplexer and start them.
   *
   * @param gateways - Gateways to add
   */
  async addGateways(gateways: Gateway[]): Promise<void> {
    for (const gw of gateways) {
      if (this.gateways.has(gw)) continue;
      try {
        await gw.start(this);
        this.gateways.add(gw);
      } catch (e) {
        console.error(
          `[haruna][${gw.name}] failed to start: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  /**
   * Remove gateways from the multiplexer and stop them.
   *
   * @param gateways - Gateways to remove
   */
  async removeGateways(gateways: Gateway[]): Promise<void> {
    const removed: Gateway[] = [];
    for (const gw of gateways) {
      if (this.gateways.delete(gw)) removed.push(gw);
    }
    await Promise.all(removed.map((gw) => stopGateway(gw)));
  }

  /**
   * Send a signal to all alive session PTY processes.
   *
   * @param signal - Signal to send (e.g. "SIGTERM", "SIGKILL")
   */
  killAll(signal: NodeJS.Signals): void {
    for (const slot of this.slots.values()) {
      if (slot.phase === "alive") {
        slot.session.ptyHandle.kill(signal);
      }
    }
  }

  /** Dispose of all managed gateways and sessions. */
  async dispose(): Promise<void> {
    // Stop all gateways
    const gateways = [...this.gateways];
    this.gateways.clear();
    for (const gw of gateways) {
      await stopGateway(gw);
    }

    // Stop all sessions
    while (this.slots.size > 0) {
      const promises: Promise<unknown>[] = [];
      for (const slot of this.slots.values()) {
        switch (slot.phase) {
          case "creating":
            promises.push(slot.ready.catch(() => {}));
            break;
          case "alive":
            // dispose() kills the PTY, which triggers the exited handler →
            // dispose (no-op, idempotent). We await exited so the next
            // iteration can pick up the "destroying" slot.
            slot.session.dispose().catch(() => {});
            promises.push(slot.session.ptyHandle.exited);
            break;
          case "destroying":
            promises.push(slot.done);
            break;
        }
      }
      await Promise.all(promises);
    }
  }

  /**
   * Reload the base configuration and re-apply to all alive sessions.
   *
   * Re-reads the config file once and distributes the fresh base
   * config to every alive session via {@link Session.reapplyBaseConfig}.
   */
  async reloadConfig(): Promise<void> {
    this._config = await this._config.reload();
    const promises: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      if (slot.phase !== "alive") continue;

      promises.push(
        slot.session.reapplyBaseConfig(this._config).catch((e) => {
          console.error(`[haruna] config reload failed: ${e instanceof Error ? e.message : e}`);
        }),
      );
    }
    await Promise.all(promises);
  }
}

/**
 * Applies gateway configuration to a {@link Multiplexer}.
 *
 * Gateways are rebuilt only when their serialized config differs.
 * The multiplexer owns the gateway lifecycle — this configurator
 * does not implement dispose.
 *
 * Not safe for concurrent calls — callers must serialize invocations.
 */
export class MultiplexerConfigurator {
  private readonly mux: Multiplexer;
  private managedGateways: Gateway[] = [];
  private appliedConfig: Config | null = null;

  constructor(mux: Multiplexer) {
    this.mux = mux;
  }

  /**
   * Apply gateway configuration on the multiplexer.
   *
   * @param config - Configuration to apply
   */
  async apply(config: Config): Promise<void> {
    if (
      this.appliedConfig === null ||
      JSON.stringify(config.gateways) !== JSON.stringify(this.appliedConfig.gateways)
    ) {
      const oldManaged = this.managedGateways;
      this.managedGateways = [];
      await this.mux.removeGateways(oldManaged);

      const newGateways = loadGateways(config.gateways);
      await this.mux.addGateways(newGateways);
      this.managedGateways = newGateways;
    }

    this.appliedConfig = config;
  }
}

function invokeCallbacks<A>(callbacks: Set<(arg: A) => void>, arg: A): void {
  for (const cb of callbacks) {
    try {
      cb(arg);
    } catch {}
  }
}

async function stopGateway(gw: Gateway): Promise<void> {
  try {
    await gw.stop();
  } catch (e) {
    console.error(`[haruna][${gw.name}] failed to stop: ${e instanceof Error ? e.message : e}`);
  }
}
