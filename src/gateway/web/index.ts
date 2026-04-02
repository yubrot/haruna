/**
 * Web Gateway — HTTP + WebSocket gateway for multiplexing mode.
 *
 * Serves a lobby page listing all sessions, per-session pages with the
 * shared browser client, and per-session WebSocket connections. Sessions
 * are created on demand when a WebSocket client connects.
 *
 * @module
 */

import type { Server, ServerWebSocket } from "bun";
import type { Channel, Frame, SendSceneInput } from "../../channel/interface.ts";
import { parseSceneInput } from "../../scene/interface.ts";
import type { Gateway, SessionManager } from "../interface.ts";
import clientPage from "./client.html";

/** Options for creating a {@link WebGateway}. */
export interface WebGatewayOptions {
  /** TCP port to listen on. */
  port: number;
  /** Host/IP to bind to. */
  host: string;
}

interface WsData {
  sessionId: string;
}

/**
 * HTTP + WebSocket gateway that serves a lobby page, per-session browser
 * clients, and manages session lifecycle via {@link SessionManager}.
 *
 * Multiple browser clients can view the same session. Sessions are created
 * via `POST /api/sessions` and cleaned up when the session is destroyed
 * (process exit).
 */
export class WebGateway implements Gateway {
  readonly name = "web";
  private readonly options: WebGatewayOptions;
  private server: Server<WsData> | null = null;
  private manager: SessionManager | null = null;
  private unsubscribeDestroyed: (() => void) | null = null;
  private readonly sessions: Map<string, WebSessionChannel> = new Map();

  constructor(options: WebGatewayOptions) {
    this.options = options;
  }

  /** The TCP port the server is listening on (0 before start). */
  get port(): number {
    return this.server?.port ?? 0;
  }

  /**
   * Start the HTTP + WebSocket server.
   *
   * @param manager - Interface for managing sessions
   */
  async start(manager: SessionManager): Promise<void> {
    if (this.server) {
      throw new Error("WebGateway is already started");
    }

    this.manager = manager;
    this.unsubscribeDestroyed = manager.onSessionDestroyed((info) => {
      const channel = this.sessions.get(info.id);
      if (channel) {
        this.sessions.delete(info.id);
        channel.closeAll();
      }
    });

    this.server = Bun.serve<WsData>({
      port: this.options.port,
      hostname: this.options.host,

      routes: {
        "/": clientPage,
        "/api/sessions": {
          GET: () => {
            return Response.json(this.manager?.list() ?? []);
          },
          POST: async (req: Request) => {
            return this.handleCreateSession(req);
          },
        },
      },

      fetch: (req, server) => {
        const url = new URL(req.url);

        // Session WebSocket upgrade: /sessions/:id/ws
        const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);
        if (wsMatch) {
          const sessionId = decodeURIComponent(wsMatch[1] as string);
          if (server.upgrade(req, { data: { sessionId } })) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        return new Response("Not Found", { status: 404 });
      },

      websocket: {
        open: (ws) => {
          this.handleWsOpen(ws);
        },
        message: (ws, message) => {
          this.handleWsMessage(ws, message);
        },
        close: (ws) => {
          this.handleWsClose(ws);
        },
      },
    });

    console.error(
      `[haruna][${this.name}] listening on http://${this.options.host}:${this.server.port}`,
    );
  }

  /**
   * Stop the server and release all resources.
   */
  async stop(): Promise<void> {
    this.unsubscribeDestroyed?.();
    this.unsubscribeDestroyed = null;

    for (const [id, channel] of this.sessions) {
      this.manager?.detach(id, channel);
      channel.closeAll();
    }
    this.sessions.clear();

    this.server?.stop(true);
    this.server = null;
    this.manager = null;
  }

  private async handleCreateSession(req: Request): Promise<Response> {
    if (!this.manager) {
      return Response.json({ error: "gateway is shutting down" }, { status: 503 });
    }

    let body: { id?: string };
    try {
      body = (await req.json()) as { id?: string };
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }

    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      return Response.json({ error: "id is required" }, { status: 400 });
    }
    if (!isValidSessionId(id)) {
      return Response.json({ error: "invalid session id" }, { status: 400 });
    }

    if (this.sessions.has(id)) {
      return Response.json({ id });
    }

    const channel = new WebSessionChannel(id);
    this.sessions.set(id, channel);

    try {
      await this.manager.request(id, channel);
    } catch (e) {
      this.sessions.delete(id);
      console.error(
        `[haruna][${this.name}] session request failed for ${id}: ${e instanceof Error ? e.message : e}`,
      );
      return Response.json({ error: "session creation failed" }, { status: 500 });
    }

    return Response.json({ id }, { status: 201 });
  }

  private handleWsOpen(ws: ServerWebSocket<WsData>): void {
    const { sessionId } = ws.data;

    const channel = this.sessions.get(sessionId);
    if (!channel) {
      ws.close(4004, "session not found");
      return;
    }

    channel.addClient(ws);
  }

  private handleWsMessage(ws: ServerWebSocket<WsData>, message: string | Buffer): void {
    const channel = this.sessions.get(ws.data.sessionId);
    if (!channel) return;

    const text = typeof message === "string" ? message : Buffer.from(message).toString("utf-8");
    const input = parseSceneInput(text);
    if (input) {
      channel.forwardInput(input);
    } else {
      console.error(`[haruna][${this.name}] invalid input from client, ignoring`);
    }
  }

  private handleWsClose(ws: ServerWebSocket<WsData>): void {
    const channel = this.sessions.get(ws.data.sessionId);
    if (!channel) return;
    channel.removeClient(ws);
  }
}

/**
 * Lightweight per-session channel created by {@link WebGateway}.
 *
 * Manages a group of WebSocket clients viewing the same session and
 * broadcasts frames to all of them.
 */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Check whether a session ID contains only safe characters. */
function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

class WebSessionChannel implements Channel {
  readonly name: string;
  private readonly clients: Set<ServerWebSocket<WsData>> = new Set();
  private send: SendSceneInput | null = null;

  constructor(sessionId: string) {
    this.name = `web:${sessionId}`;
  }

  /** The number of currently connected WebSocket clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  async start(send: SendSceneInput | null): Promise<void> {
    this.send = send;
  }

  async stop(): Promise<void> {
    this.closeAll();
    this.send = null;
  }

  receive(frame: Frame): void {
    if (this.clients.size === 0) return;

    const data = JSON.stringify(frame);

    for (const client of this.clients) {
      const result = client.send(data);
      if (result < 0) {
        client.close();
        this.clients.delete(client);
      }
    }
  }

  /** Add a WebSocket client to this session's broadcast group. */
  addClient(ws: ServerWebSocket<WsData>): void {
    this.clients.add(ws);
  }

  /** Remove a WebSocket client from this session's broadcast group. */
  removeClient(ws: ServerWebSocket<WsData>): void {
    this.clients.delete(ws);
  }

  /** Forward structured input from a browser client to the session. */
  forwardInput(input: ReturnType<typeof parseSceneInput>): void {
    if (input) {
      this.send?.(input);
    }
  }

  /** Close all connected clients. */
  closeAll(): void {
    for (const client of this.clients) client.close();
    this.clients.clear();
  }
}
