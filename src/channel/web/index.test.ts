import { afterEach, describe, expect, test } from "bun:test";
import { collectingSend, frame, waitFor } from "../__testing.ts";
import type { Frame } from "../interface.ts";
import { WebChannel } from "./index.ts";

/** Connect a WebSocket test client to the given port. */
function testClient(port: number): Promise<{
  messages: string[];
  send: (data: string) => void;
  close: () => void;
  waitForMessages: (n: number) => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

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

describe("WebChannel", () => {
  const servers: WebChannel[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await s.stop();
    }
    servers.length = 0;
  });

  /** Create and track a server for automatic cleanup. */
  function createServer(port = 0): WebChannel {
    const s = new WebChannel({ port, host: "127.0.0.1" });
    servers.push(s);
    return s;
  }

  test("starts and stops cleanly", async () => {
    const server = createServer();
    await server.start(null);
    expect(server.port).toBeGreaterThan(0);
    await server.stop();
  });

  test("serves HTML on GET /", async () => {
    const server = createServer();
    await server.start(null);

    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("haruna");
  });

  test("sends output to all connected clients", async () => {
    const server = createServer();
    await server.start(null);

    const client1 = await testClient(server.port);
    const client2 = await testClient(server.port);
    await waitFor(() => server.clientCount === 2);

    server.receive(frame(["multi"]));

    await client1.waitForMessages(1);
    await client2.waitForMessages(1);

    const parsed1 = JSON.parse(client1.messages[0] as string) as Frame;
    const parsed2 = JSON.parse(client2.messages[0] as string) as Frame;
    expect(parsed1.events).toMatchObject([{ type: "message_created" }]);
    expect(parsed2.events).toMatchObject([{ type: "message_created" }]);

    client1.close();
    client2.close();
  });

  test("sends output even when there are no events", async () => {
    const server = createServer();
    await server.start(null);

    const client = await testClient(server.port);
    await waitFor(() => server.clientCount === 1);

    server.receive(frame());

    await client.waitForMessages(1);
    const parsed = JSON.parse(client.messages[0] as string) as Frame;
    expect(parsed.events).toEqual([]);
    expect(parsed.snapshot).toBeDefined();

    client.close();
  });

  test("receive does not error after client disconnects", async () => {
    const server = createServer();
    await server.start(null);

    const client = await testClient(server.port);
    await waitFor(() => server.clientCount === 1);

    client.close();
    await waitFor(() => server.clientCount === 0);

    // Should not throw
    server.receive(frame());
  });

  test("tracks client count correctly", async () => {
    const server = createServer();
    await server.start(null);

    expect(server.clientCount).toBe(0);

    const client1 = await testClient(server.port);
    await waitFor(() => server.clientCount === 1);

    const client2 = await testClient(server.port);
    await waitFor(() => server.clientCount === 2);

    client1.close();
    await waitFor(() => server.clientCount === 1);

    client2.close();
    await waitFor(() => server.clientCount === 0);
  });

  test("waitForClient blocks start() until a client connects", async () => {
    const server = new WebChannel({
      port: 0,
      host: "127.0.0.1",
      waitForClient: true,
    });
    servers.push(server);

    let started = false;
    const startPromise = server.start(null).then(() => {
      started = true;
    });

    // Server must be listening for WS connections even though start() hasn't resolved
    await Bun.sleep(50);
    expect(started).toBe(false);

    // Connect a client — this should unblock start()
    const client = await testClient(server.port);
    await startPromise;
    expect(started).toBe(true);

    client.close();
  });

  test("stop() resolves pending waitForClient promise", async () => {
    const server = new WebChannel({
      port: 0,
      host: "127.0.0.1",
      waitForClient: true,
    });
    servers.push(server);

    let started = false;
    const startPromise = server.start(null).then(() => {
      started = true;
    });

    await Bun.sleep(50);
    expect(started).toBe(false);

    await server.stop();
    await startPromise;
    expect(started).toBe(true);
  });

  test("forwards valid TextInput from client via send callback", async () => {
    const server = createServer();
    const { inputs, send } = collectingSend();
    await server.start(send);

    const client = await testClient(server.port);
    await waitFor(() => server.clientCount === 1);

    client.send('{"type":"text","content":"hello world"}');
    await waitFor(() => inputs.length === 1);

    expect(inputs[0]).toEqual({ type: "text", content: "hello world" });

    client.close();
  });

  test("ignores invalid JSON from client", async () => {
    const server = createServer();
    const { inputs, send } = collectingSend();
    await server.start(send);

    const client = await testClient(server.port);
    await waitFor(() => server.clientCount === 1);

    // Invalid JSON followed by valid input as sentinel
    client.send("not valid json");
    client.send('{"type":"text","content":"sentinel"}');
    await waitFor(() => inputs.length === 1);

    expect(inputs[0]).toEqual({ type: "text", content: "sentinel" });

    client.close();
  });

  test("ignores unrecognized input types from client", async () => {
    const server = createServer();
    const { inputs, send } = collectingSend();
    await server.start(send);

    const client = await testClient(server.port);
    await waitFor(() => server.clientCount === 1);

    client.send('{"type":"unknown","data":"foo"}');
    client.send('{"type":"text","content":"sentinel"}');
    await waitFor(() => inputs.length === 1);

    expect(inputs[0]).toEqual({ type: "text", content: "sentinel" });

    client.close();
  });

  test("broadcasts full output including snapshot and events", async () => {
    const server = createServer();
    await server.start(null);

    const client = await testClient(server.port);
    await waitFor(() => server.clientCount === 1);

    const output = frame(["test-content"]);
    server.receive(output);

    await client.waitForMessages(1);
    const parsed = JSON.parse(client.messages[0] as string) as Frame;
    expect(parsed.snapshot).toBeDefined();
    expect(parsed.snapshot.lines).toBeDefined();
    expect(parsed.events).toMatchObject([{ type: "message_created" }]);

    client.close();
  });
});
