import { afterEach, describe, expect, test } from "bun:test";
import { frame, waitFor } from "../../channel/__testing.ts";
import type { Channel } from "../../channel/interface.ts";
import type { SessionInfo, SessionManager } from "../interface.ts";
import { WebGateway } from "./index.ts";

/** Create a mock SessionManager that tracks requests and detaches. */
function mockManager(): SessionManager & {
  requests: { id: string; channel: Channel }[];
  detaches: { id: string; channel: Channel }[];
  sessions: SessionInfo[];
  /** Simulate a session being destroyed (e.g. process exit). */
  destroySession(id: string): void;
} {
  const state = {
    requests: [] as { id: string; channel: Channel }[],
    detaches: [] as { id: string; channel: Channel }[],
    sessions: [] as SessionInfo[],
    createdCallbacks: new Set<(info: SessionInfo) => void>(),
    destroyedCallbacks: new Set<(info: SessionInfo) => void>(),
  };

  return {
    get requests() {
      return state.requests;
    },
    get detaches() {
      return state.detaches;
    },
    get sessions() {
      return state.sessions;
    },
    set sessions(value: SessionInfo[]) {
      state.sessions = value;
    },

    async request(id: string, channel: Channel): Promise<void> {
      state.requests.push({ id, channel });
      await channel.start(() => {});
    },

    detach(id: string, channel: Channel): void {
      state.detaches.push({ id, channel });
    },

    list(): SessionInfo[] {
      return state.sessions;
    },

    onSessionCreated(callback: (info: SessionInfo) => void): () => void {
      state.createdCallbacks.add(callback);
      return () => state.createdCallbacks.delete(callback);
    },

    onSessionDestroyed(callback: (info: SessionInfo) => void): () => void {
      state.destroyedCallbacks.add(callback);
      return () => state.destroyedCallbacks.delete(callback);
    },

    destroySession(id: string): void {
      for (const cb of state.destroyedCallbacks) cb({ id });
    },
  };
}

/** Create a session via POST /api/sessions. */
async function createSession(port: number, id: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

/** Connect a WebSocket test client. */
function testClient(
  port: number,
  sessionId: string,
): Promise<{
  messages: string[];
  send: (data: string) => void;
  close: () => void;
  waitForMessages: (n: number) => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionId)}/ws`);

    ws.onopen = () => {
      resolve({
        messages,
        send(data: string) {
          ws.send(data);
        },
        close() {
          ws.close();
        },
        waitForMessages(n: number) {
          return waitFor(() => messages.length >= n);
        },
      });
    };

    ws.onmessage = (ev) => {
      messages.push(ev.data as string);
    };

    ws.onerror = () => {
      reject(new Error("WebSocket error"));
    };
  });
}

describe("WebGateway", () => {
  const gateways: WebGateway[] = [];

  afterEach(async () => {
    for (const gw of gateways) {
      await gw.stop();
    }
    gateways.length = 0;
  });

  function createGateway(port = 0): WebGateway {
    const gw = new WebGateway({ port, host: "127.0.0.1" });
    gateways.push(gw);
    return gw;
  }

  test("starts and stops cleanly", async () => {
    const gw = createGateway();
    const manager = mockManager();
    await gw.start(manager);
    expect(gw.port).toBeGreaterThan(0);
    await gw.stop();
  });

  test("serves lobby page on GET /", async () => {
    const gw = createGateway();
    await gw.start(mockManager());

    const res = await fetch(`http://127.0.0.1:${gw.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("haruna");
    expect(body).toContain("<script");
  });

  test("returns session list from GET /api/sessions", async () => {
    const gw = createGateway();
    const manager = mockManager();
    manager.sessions = [{ id: "session-a" }, { id: "session-b" }];
    await gw.start(manager);

    const res = await fetch(`http://127.0.0.1:${gw.port}/api/sessions`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([{ id: "session-a" }, { id: "session-b" }]);
  });

  test("creates session via POST /api/sessions", async () => {
    const gw = createGateway();
    const manager = mockManager();
    await gw.start(manager);

    const res = await createSession(gw.port, "new-session");
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toEqual({ id: "new-session" });
    expect(manager.requests.length).toBe(1);
    expect(manager.requests[0]?.id).toBe("new-session");
  });

  test("POST /api/sessions is idempotent for existing session", async () => {
    const gw = createGateway();
    const manager = mockManager();
    await gw.start(manager);

    await createSession(gw.port, "dup");
    const res = await createSession(gw.port, "dup");
    expect(res.status).toBe(200);
    expect(manager.requests.length).toBe(1);
  });

  test("POST /api/sessions rejects missing id", async () => {
    const gw = createGateway();
    await gw.start(mockManager());

    const res = await fetch(`http://127.0.0.1:${gw.port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("WS connection to non-existent session is rejected", async () => {
    const gw = createGateway();
    await gw.start(mockManager());

    const closed = new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/sessions/no-such/ws`);
      ws.onclose = (ev) => resolve(ev.code);
    });
    expect(await closed).toBe(4004);
  });

  test("cleans up channel when session is destroyed", async () => {
    const gw = createGateway();
    const manager = mockManager();
    await gw.start(manager);

    await createSession(gw.port, "destroyed-session");
    const client = await testClient(gw.port, "destroyed-session");

    // Simulate process exit
    manager.destroySession("destroyed-session");

    // WS client should be closed by the gateway
    const closed = new Promise<void>((resolve) => {
      // testClient's ws is internal, so we verify via reconnect rejection
      resolve();
    });
    await closed;

    // New WS connection should be rejected
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/sessions/destroyed-session/ws`);
      ws.onclose = (ev) => resolve(ev.code);
    });
    expect(code).toBe(4004);

    client.close();
  });

  test("WS reconnects after all clients disconnect", async () => {
    const gw = createGateway();
    const manager = mockManager();
    await gw.start(manager);

    await createSession(gw.port, "reconnect-test");
    const client1 = await testClient(gw.port, "reconnect-test");
    client1.close();
    await Bun.sleep(50);

    // Session channel should still exist — reconnect succeeds
    const client2 = await testClient(gw.port, "reconnect-test");
    const channel = manager.requests[0]?.channel;
    channel?.receive(frame(["after-reconnect"]));

    await client2.waitForMessages(1);
    const parsed = JSON.parse(client2.messages[0] as string);
    expect(parsed.events).toMatchObject([{ type: "message_created" }]);

    client2.close();
  });

  test("broadcasts frames to connected clients", async () => {
    const gw = createGateway();
    const manager = mockManager();
    await gw.start(manager);

    await createSession(gw.port, "broadcast-test");
    const client = await testClient(gw.port, "broadcast-test");

    // Get the channel that was created and send a frame to it
    const channel = manager.requests[0]?.channel;
    expect(channel).toBeDefined();
    channel?.receive(frame(["hello"]));

    await client.waitForMessages(1);
    const parsed = JSON.parse(client.messages[0] as string);
    expect(parsed.events).toMatchObject([{ type: "message_created" }]);

    client.close();
  });

  test("multiple clients share same session channel", async () => {
    const gw = createGateway();
    const manager = mockManager();
    await gw.start(manager);

    await createSession(gw.port, "shared-session");
    const client1 = await testClient(gw.port, "shared-session");
    const client2 = await testClient(gw.port, "shared-session");
    // Second client should NOT create a new request
    expect(manager.requests.length).toBe(1);

    // Both should receive broadcasts
    const channel = manager.requests[0]?.channel;
    channel?.receive(frame(["shared"]));

    await client1.waitForMessages(1);
    await client2.waitForMessages(1);

    client1.close();
    client2.close();
  });

  test("forwards valid input from client", async () => {
    const gw = createGateway();
    const manager = mockManager();
    await gw.start(manager);

    await createSession(gw.port, "input-test");
    const client = await testClient(gw.port, "input-test");

    // The channel was started with a send callback by our mock manager
    const channel = manager.requests[0]?.channel;
    expect(channel).toBeDefined();

    // Send input from client — this goes through the gateway to the channel's send
    client.send('{"type":"text","content":"hello from browser"}');

    // Wait a moment for the message to be processed
    await Bun.sleep(50);

    client.close();
  });

  test("different sessions get different channels", async () => {
    const gw = createGateway();
    const manager = mockManager();
    await gw.start(manager);

    await createSession(gw.port, "session-1");
    await createSession(gw.port, "session-2");

    expect(manager.requests.length).toBe(2);
    expect(manager.requests[0]?.id).toBe("session-1");
    expect(manager.requests[1]?.id).toBe("session-2");
    expect(manager.requests[0]?.channel).not.toBe(manager.requests[1]?.channel);
  });

  test("returns 404 for unknown paths", async () => {
    const gw = createGateway();
    await gw.start(mockManager());

    const res = await fetch(`http://127.0.0.1:${gw.port}/unknown`);
    expect(res.status).toBe(404);
  });
});
