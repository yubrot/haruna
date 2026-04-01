import { afterEach, describe, expect, test } from "bun:test";
import type { Channel, Frame } from "./channel/interface.ts";
import { Config, parseConfig } from "./config.ts";
import type { Gateway, SessionInfo, SessionManager } from "./gateway/interface.ts";
import { Multiplexer, MultiplexerConfigurator } from "./multiplexer.ts";

/** Create a stub gateway that tracks start/stop lifecycle. */
function stubGateway(
  gatewayName = "test-gw",
): Gateway & { started: boolean; stopped: boolean; manager: SessionManager | null } {
  return {
    name: gatewayName,
    started: false,
    stopped: false,
    manager: null,
    async start(manager) {
      this.started = true;
      this.manager = manager;
    },
    async stop() {
      this.stopped = true;
    },
  };
}

/** Create a stub channel that records received frames. */
function stubChannel(name = "test"): Channel & { frames: Frame[]; stopped: boolean } {
  const frames: Frame[] = [];
  return {
    name,
    frames,
    stopped: false,
    async start() {},
    async stop() {
      this.stopped = true;
    },
    receive(frame) {
      frames.push(frame);
    },
  };
}

/** Create a Multiplexer with a long-lived command (cat blocks until stdin closes). */
function createMux(command: string[] = ["cat"]): Multiplexer {
  const config = new Config(parseConfig({ command }), null, process.cwd());
  return new Multiplexer({ config });
}

/** Poll until a condition becomes true, with a timeout. */
async function waitFor(condition: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await Bun.sleep(intervalMs);
  }
}

// Track multiplexers for cleanup
const muxes: Multiplexer[] = [];
function tracked(mux: Multiplexer): Multiplexer {
  muxes.push(mux);
  return mux;
}

afterEach(async () => {
  for (const mux of muxes) {
    await mux.dispose().catch(() => {});
  }
  muxes.length = 0;
});

describe("Multiplexer", () => {
  test("request creates a new session", async () => {
    const mux = tracked(createMux());
    const ch = stubChannel();
    await mux.request("session-1", ch);

    const sessions = mux.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("session-1");
  });

  test("request is idempotent for the same channel", async () => {
    const mux = tracked(createMux());
    const ch = stubChannel();
    await mux.request("session-1", ch);
    await mux.request("session-1", ch);

    expect(mux.list()).toHaveLength(1);
  });

  test("multiple requests with different channels attach to the same session", async () => {
    const mux = tracked(createMux(["cat"]));
    const ch1 = stubChannel("ch1");
    const ch2 = stubChannel("ch2");

    await mux.request("session-1", ch1);
    await mux.request("session-1", ch2);

    expect(mux.list()).toHaveLength(1);
  });

  test("detach removes a channel", async () => {
    const mux = tracked(createMux(["cat"]));
    const ch = stubChannel();
    await mux.request("session-1", ch);

    mux.detach("session-1", ch);
    // Session still exists even after detaching the channel
    expect(mux.list()).toHaveLength(1);
  });

  test("detach is a no-op for unknown session or channel", () => {
    const mux = tracked(createMux());
    const ch = stubChannel();
    // Should not throw
    mux.detach("nonexistent", ch);
  });

  test("PTY exit destroys the session and fires onSessionDestroyed", async () => {
    const mux = tracked(createMux(["echo", "bye"]));
    const destroyedPromise = new Promise<SessionInfo>((resolve) => mux.onSessionDestroyed(resolve));

    const ch = stubChannel();
    await mux.request("session-1", ch);

    const destroyed = await destroyedPromise;
    expect(mux.list()).toHaveLength(0);
    expect(destroyed.id).toBe("session-1");
  });

  test("onSessionCreated fires when a session is created", async () => {
    const mux = tracked(createMux());
    const created: SessionInfo[] = [];
    mux.onSessionCreated((info) => created.push(info));

    const ch = stubChannel();
    await mux.request("session-1", ch);

    expect(created).toHaveLength(1);
    expect(created[0]?.id).toBe("session-1");
  });

  test("unsubscribe stops callbacks", async () => {
    const mux = tracked(createMux());
    const created: SessionInfo[] = [];
    const unsub = mux.onSessionCreated((info) => created.push(info));
    unsub();

    const ch = stubChannel();
    await mux.request("session-1", ch);

    expect(created).toHaveLength(0);
  });

  test("concurrent requests for the same ID are serialized", async () => {
    const mux = tracked(createMux(["cat"]));
    const ch1 = stubChannel("ch1");
    const ch2 = stubChannel("ch2");

    await Promise.all([mux.request("session-1", ch1), mux.request("session-1", ch2)]);

    expect(mux.list()).toHaveLength(1);
  });

  test("list returns all active sessions", async () => {
    const mux = tracked(createMux(["cat"]));
    const ch1 = stubChannel("ch1");
    const ch2 = stubChannel("ch2");

    await mux.request("session-1", ch1);
    await mux.request("session-2", ch2);

    const sessions = mux.list();
    expect(sessions).toHaveLength(2);
    const ids = sessions.map((s) => s.id).sort();
    expect(ids).toEqual(["session-1", "session-2"]);
  });

  test("dispose kills all sessions", async () => {
    const mux = tracked(createMux(["cat"]));
    const destroyed: SessionInfo[] = [];
    mux.onSessionDestroyed((info) => destroyed.push(info));

    const ch1 = stubChannel("ch1");
    const ch2 = stubChannel("ch2");
    await mux.request("session-1", ch1);
    await mux.request("session-2", ch2);

    await mux.dispose();

    expect(mux.list()).toHaveLength(0);
    expect(destroyed).toHaveLength(2);
  });

  test("init command failure rejects request", async () => {
    const config = new Config(parseConfig({ init: "exit 1" }), null, process.cwd());
    const mux = tracked(new Multiplexer({ config }));
    const ch = stubChannel();

    await expect(mux.request("session-1", ch)).rejects.toThrow("init command exited with code 1");
  });

  test("channel receives frames from PTY output", async () => {
    const mux = tracked(createMux(["bash", "-c", "echo hello && sleep 1"]));
    const ch = stubChannel();
    await mux.request("session-1", ch);

    // Poll until the channel receives at least one frame (VT debounce + PTY output)
    await waitFor(() => ch.frames.length > 0);
    expect(ch.frames.length).toBeGreaterThan(0);
  });

  test("addGateways starts gateways and passes the multiplexer as manager", async () => {
    const mux = tracked(createMux());
    const gw = stubGateway();

    await mux.addGateways([gw]);

    expect(gw.started).toBe(true);
    expect(gw.manager).toBe(mux);
  });

  test("addGateways skips already-added gateways", async () => {
    const mux = tracked(createMux());
    const gw = stubGateway();

    await mux.addGateways([gw]);
    gw.started = false;
    await mux.addGateways([gw]);

    expect(gw.started).toBe(false);
  });

  test("addGateways skips gateways that fail to start", async () => {
    const mux = tracked(createMux());
    const gw1 = stubGateway("gw1");
    const gw2: Gateway = {
      name: "gw2",
      async start() {
        throw new Error("start failed");
      },
      async stop() {},
    };
    const gw3 = stubGateway("gw3");

    await mux.addGateways([gw1, gw2, gw3]);
    expect(gw1.started).toBe(true);
    expect(gw3.started).toBe(true);
    expect(mux.list()).toEqual([]); // no sessions, but gateways are managed
  });

  test("removeGateways stops and removes gateways", async () => {
    const mux = tracked(createMux());
    const gw = stubGateway();

    await mux.addGateways([gw]);
    await mux.removeGateways([gw]);

    expect(gw.stopped).toBe(true);
    // Adding again should re-start (not skipped as duplicate)
    gw.started = false;
    gw.stopped = false;
    await mux.addGateways([gw]);
    expect(gw.started).toBe(true);
  });

  test("removeGateways ignores unknown gateways", async () => {
    const mux = tracked(createMux());
    const gw = stubGateway();

    // Should not throw
    await mux.removeGateways([gw]);
    expect(gw.stopped).toBe(false);
  });

  test("dispose stops gateways before sessions", async () => {
    const mux = tracked(createMux(["cat"]));
    const gw = stubGateway();
    await mux.addGateways([gw]);

    const ch = stubChannel();
    await mux.request("session-1", ch);

    await mux.dispose();

    expect(gw.stopped).toBe(true);
    expect(mux.list()).toHaveLength(0);
  });
});

describe("MultiplexerConfigurator", () => {
  test("apply starts gateways from config", async () => {
    const mux = tracked(createMux());
    const configurator = new MultiplexerConfigurator(mux);
    const config = new Config(parseConfig({ gateways: [] }), null, process.cwd());

    // With empty gateways config, nothing crashes
    await configurator.apply(config);
  });

  test("apply is idempotent for the same config", async () => {
    const mux = tracked(createMux());
    const configurator = new MultiplexerConfigurator(mux);
    const config = new Config(parseConfig({ gateways: [] }), null, process.cwd());

    await configurator.apply(config);
    // Second apply with same config should be a no-op
    await configurator.apply(config);
  });

  test("apply rebuilds gateways when config changes", async () => {
    const mux = tracked(createMux());
    const configurator = new MultiplexerConfigurator(mux);
    const config1 = new Config(parseConfig({ gateways: [] }), null, process.cwd());
    const config2 = new Config(
      parseConfig({ gateways: [{ type: "unknown-type-for-test" }] }),
      null,
      process.cwd(),
    );

    await configurator.apply(config1);
    // Changing gateways config triggers rebuild (even if loadGateways returns empty for unknown types)
    await configurator.apply(config2);
  });
});
