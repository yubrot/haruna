/*ReturnType
 * HTTP + WebSocket channel for streaming events to browser clients
 * and receiving structured input back.
 *
 * Serves a single-page browser client on `GET /` and upgrades
 * `GET /ws` to a WebSocket connection.
 *
 * @module
 */

import type { Server, ServerWebSocket } from "bun";
import { parseSceneInput } from "../../scene/interface.ts";
import type { Channel, Frame, SendSceneInput } from "../interface.ts";
import clientPage from "./client.html";

/**
 * Options for creating a WebChannel.
 *
 * WebChannel provides a browser-based UI for observing scene events
 * and sending input to the PTY. For recording or debugging, use
 * {@link DumpChannel} instead.
 */
export interface WebChannelOptions {
  /** TCP port to listen on. */
  port: number;
  /** Host/IP to bind to. */
  host: string;
  /**
   * When `true`, `start()` resolves only after the first WebSocket
   * client connects. When `false` (default), `start()` resolves
   * immediately after the server is bound. Useful for replay mode
   * where processing should wait for an observer.
   */
  waitForClient?: boolean;
}

/**
 * HTTP + WebSocket channel that serves a browser client, broadcasts
 * output as JSON to connected WebSocket clients, and forwards
 * structured input from clients to the system via a {@link SendSceneInput}
 * callback.
 */
export class WebChannel implements Channel {
  readonly name = "web";
  private readonly options: Required<WebChannelOptions>;
  private server: Server<unknown> | null = null;
  private readonly clients: Set<ServerWebSocket<unknown>> = new Set();
  private clientConnectedResolve: (() => void) | null = null;
  private send: SendSceneInput | null = null;

  /**
   * Create a new WebChannel.
   *
   * @param options - Server configuration
   */
  constructor(options: WebChannelOptions) {
    this.options = {
      port: options.port,
      host: options.host,
      waitForClient: options.waitForClient ?? false,
    };
  }

  /** The TCP port the server is listening on (0 before start). */
  get port(): number {
    return this.server?.port ?? 0;
  }

  /** The number of currently connected WebSocket clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Start the HTTP + WebSocket server.
   *
   * @param send - Callback for sending structured input back to the system
   * @returns A promise that resolves when the channel is ready
   */
  async start(send: SendSceneInput | null): Promise<void> {
    if (this.server) {
      throw new Error("WebChannel is already started");
    }

    this.send = send;

    const clientConnected = this.options.waitForClient
      ? new Promise<void>((resolve) => {
          this.clientConnectedResolve = resolve;
        })
      : Promise.resolve();

    this.server = Bun.serve({
      port: this.options.port,
      hostname: this.options.host,

      routes: {
        "/": clientPage,
      },

      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          if (server.upgrade(req, { data: undefined })) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return new Response("Not Found", { status: 404 });
      },

      websocket: {
        open: (ws) => {
          this.clients.add(ws);
          if (this.clientConnectedResolve) {
            this.clientConnectedResolve();
            this.clientConnectedResolve = null;
          }
        },
        message: (_ws, message) => {
          const input = parseSceneInput(
            typeof message === "string"
              ? message
              : Buffer.from(message).toString("utf-8"),
          );
          if (input) {
            this.send?.(input);
          } else {
            console.error("haruna: web: invalid input from client, ignoring");
          }
        },
        close: (ws) => {
          this.clients.delete(ws);
        },
      },
    });

    console.error(
      `haruna: web: listening on http://${this.options.host}:${this.server.port}`,
    );

    return clientConnected;
  }

  /**
   * Stop the server and clean up resources.
   *
   * @returns A promise that resolves when the channel has fully stopped
   */
  async stop(): Promise<void> {
    // Resolve any pending waitForClient promise so callers don't hang
    if (this.clientConnectedResolve) {
      this.clientConnectedResolve();
      this.clientConnectedResolve = null;
    }

    for (const client of this.clients) client.close();
    this.clients.clear();

    this.server?.stop(true);
    this.server = null;
    this.send = null;
  }

  /**
   * Deliver output from a snapshot change to all connected WebSocket clients.
   *
   * The entire {@link Frame} (snapshot + events) is serialized as a single
   * JSON message. Clients that cannot keep up (backpressure) are disconnected.
   *
   * @param output - The output batch to broadcast
   */
  receive(frame: Frame): void {
    if (this.clients.size === 0) return;

    const data = JSON.stringify(frame);

    for (const client of this.clients) {
      const result = client.send(data);
      if (result < 0) {
        // Backpressure: drop the slow client rather than queuing
        client.close();
        this.clients.delete(client);
      }
    }
  }
}
