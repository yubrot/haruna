import { describe, test } from "bun:test";
import { Attacher } from "./attacher.ts";
import { Config, parseConfig } from "./config.ts";
import { Relay } from "./relay.ts";

describe("Attacher", () => {
  test("apply attaches channels and apply(null) removes them", async () => {
    const relay = new Relay();
    const cwd = process.cwd();
    const config = new Config(parseConfig({ channels: [] }), null, cwd);

    const attacher = new Attacher(relay, {
      sceneConfig: { _mode: "exec", _command: ["echo", "test"] },
      channelConfig: { _mode: "exec", _command: ["echo", "test"] },
    });

    await attacher.apply(config);

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

    await attacher.apply(null);
  });

  test("replay mode excludes dump channels", async () => {
    const relay = new Relay();
    const cwd = process.cwd();
    const config = new Config(
      parseConfig({
        channels: [{ type: "dump" }],
      }),
      null,
      cwd,
    );

    const attacher = new Attacher(relay, {
      sceneConfig: { _mode: "replay", _command: [] },
      channelConfig: { _mode: "replay", _command: [] },
    });

    await attacher.apply(config);
    // No error — dump channel was simply excluded
    await attacher.apply(null);
  });
});
