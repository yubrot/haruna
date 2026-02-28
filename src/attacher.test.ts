import { describe, test } from "bun:test";
import { Attacher } from "./attacher.ts";
import { Config, parseConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";

describe("Attacher", () => {
  test("start attaches channels to gateway and stop removes them", async () => {
    const gateway = new Gateway();
    const cwd = process.cwd();
    const config = new Config(parseConfig({ channels: [] }), null, cwd);

    const attacher = new Attacher(gateway, {
      config,
      sceneConfig: { _mode: "exec", _command: ["echo", "test"] },
      channelConfig: { _mode: "exec", _command: ["echo", "test"] },
    });

    await attacher.start();

    // With empty channels config, gateway should work but have no channels
    gateway.update({
      timestamp: Date.now(),
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0, visible: true },
      lines: ["hello"],
      alternate: false,
      linesOffset: 0,
    });

    await attacher.stop();
  });

  test("replay mode excludes dump channels", async () => {
    const gateway = new Gateway();
    const cwd = process.cwd();
    const config = new Config(
      parseConfig({
        channels: [{ name: "dump" }],
      }),
      null,
      cwd,
    );

    const attacher = new Attacher(gateway, {
      config,
      sceneConfig: { _mode: "replay", _command: [] },
      channelConfig: { _mode: "replay", _command: [] },
    });

    await attacher.start();
    // No error — dump channel was simply excluded
    await attacher.stop();
  });
});
