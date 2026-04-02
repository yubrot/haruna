/**
 * Gateway and SessionManager interfaces for multiplexing mode.
 *
 * A Gateway bridges external services (Slack, Web UI, etc.) to the session
 * pool. It listens for triggers and dynamically creates or reconnects
 * sessions via the {@link SessionManager}.
 *
 * @module
 */

import type { Channel } from "../channel/interface.ts";

/** Metadata describing a managed session. */
export interface SessionInfo {
  /** Session ID issued by the Gateway (e.g. `"slack:C123:1234.5678"`). */
  id: string;
}

/**
 * Interface provided to Gateways for managing sessions.
 *
 * The Multiplexer implements this interface. Gateways call {@link request}
 * and {@link detach} at their own discretion to create, attach to, and
 * detach from sessions.
 */
export interface SessionManager {
  /**
   * Request a session by ID and attach a channel to it.
   *
   * If the session does not exist, it is created (init -> start -> attach).
   * If it already exists, the channel is attached to the running session.
   * This operation is idempotent for a given (id, channel) pair.
   *
   * @param id - Session ID issued by the Gateway
   * @param channel - Channel to attach to the session
   */
  request(id: string, channel: Channel): Promise<void>;

  /**
   * Detach a channel from a session.
   *
   * @param id - Session ID to detach from
   * @param channel - Channel to detach
   */
  detach(id: string, channel: Channel): void;

  /**
   * List all active sessions.
   *
   * @returns Snapshot of currently running sessions
   */
  list(): SessionInfo[];

  /**
   * Register a callback invoked when a new session is created.
   *
   * @param callback - Called with the session info on creation
   * @returns An unsubscribe function
   */
  onSessionCreated(callback: (info: SessionInfo) => void): () => void;

  /**
   * Register a callback invoked when a session is destroyed.
   *
   * @param callback - Called with the session info on destruction
   * @returns An unsubscribe function
   */
  onSessionDestroyed(callback: (info: SessionInfo) => void): () => void;
}

/**
 * A Gateway bridges an external service to the session pool.
 *
 * Unlike a {@link Channel} (which is attached to a single session),
 * a Gateway _creates_ Channel instances and attaches them to sessions
 * via the {@link SessionManager}. For example, a Slack Gateway listens
 * on a single connection and spawns a per-thread Channel for each session.
 */
export interface Gateway {
  /** Human-readable identifier for logging and diagnostics. */
  readonly name: string;

  /**
   * Start the gateway.
   *
   * The gateway should begin listening for triggers and call
   * {@link SessionManager.request} / {@link SessionManager.detach}
   * as appropriate.
   *
   * @param manager - Interface for managing sessions
   */
  start(manager: SessionManager): Promise<void>;

  /**
   * Stop the gateway and release resources.
   */
  stop(): Promise<void>;
}
