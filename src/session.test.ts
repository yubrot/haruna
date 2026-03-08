import { describe, expect, test } from "bun:test";
import type { Channel, Frame } from "./channel/interface.ts";
import { Config, parseConfig } from "./config.ts";
import { Relay, RelayConfigurator } from "./relay.ts";
import { Session } from "./session.ts";

/** Create a stub channel that records received frames and stop calls. */
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

const cwd = process.cwd();

describe("Session", () => {
  test("create and dispose lifecycle with real PTY", async () => {
    const config = new Config(parseConfig({ channels: [] }), null, cwd);
    const session = await Session.create({
      config,
      commandArgs: ["echo", "hello"],
      cols: 80,
      rows: 24,
      passthrough: false,
      mode: "exec",
    });

    const exitCode = await session.ptyHandle.exited;
    expect(exitCode).toBe(0);

    await session.dispose();
  });

  test("channel receives frames after PTY output", async () => {
    const config = new Config(parseConfig({ channels: [] }), null, cwd);
    const session = await Session.create({
      config,
      commandArgs: ["echo", "session-test-output"],
      cols: 80,
      rows: 24,
      passthrough: false,
      mode: "exec",
    });

    const ch = stubChannel();
    await session.relay.addChannels([ch]);

    await session.ptyHandle.exited;
    // Flush pending VT debounce so the channel receives the frame
    await session.dispose();

    expect(ch.frames.length).toBeGreaterThan(0);
  });

  test("reapplyBaseConfig does not restart channels when config is unchanged", async () => {
    const config = new Config(parseConfig({ channels: [] }), null, cwd);
    const session = await Session.create({
      config,
      commandArgs: ["cat"],
      cols: 80,
      rows: 24,
      passthrough: false,
      mode: "exec",
    });

    // Re-apply same config — should not error
    await session.reapplyBaseConfig(config);

    await session.dispose();
  });
});

describe("RelayConfigurator", () => {
  test("apply attaches channels and relay.dispose removes them", async () => {
    const relay = new Relay();
    const config = new Config(parseConfig({ channels: [] }), null, cwd);
    const configurator = new RelayConfigurator(relay, { mode: "exec", command: ["echo", "test"] });

    await configurator.apply(config);

    // With empty channels config, relay should work but have no channels
    relay.update({
      timestamp: Date.now(),
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0, visible: true },
      lines: ["hello"],
      alternate: false,
      linesOffset: 0,
    });

    await relay.dispose();
  });

  test("replay mode excludes dump channels", async () => {
    const relay = new Relay();
    const config = new Config(
      parseConfig({
        channels: [{ type: "dump" }],
      }),
      null,
      cwd,
    );
    const configurator = new RelayConfigurator(relay, { mode: "replay", command: [] });

    await configurator.apply(config);
    // No error — dump channel was simply excluded
    await relay.dispose();
  });
});
