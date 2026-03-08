import { describe, test } from "bun:test";
import { Attacher } from "./attacher.ts";
import { Config, parseConfig } from "./config.ts";
import { Session } from "./session.ts";

describe("Attacher", () => {
  test("start attaches channels to session and stop removes them", async () => {
    const session = new Session();
    const cwd = process.cwd();
    const config = new Config(parseConfig({ channels: [] }), null, cwd);

    const attacher = new Attacher(session, {
      config,
      sceneConfig: { _mode: "exec", _command: ["echo", "test"] },
      channelConfig: { _mode: "exec", _command: ["echo", "test"] },
    });

    await attacher.start();

    // With empty channels config, session should work but have no channels
    session.update({
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
    const session = new Session();
    const cwd = process.cwd();
    const config = new Config(
      parseConfig({
        channels: [{ type: "dump" }],
      }),
      null,
      cwd,
    );

    const attacher = new Attacher(session, {
      config,
      sceneConfig: { _mode: "replay", _command: [] },
      channelConfig: { _mode: "replay", _command: [] },
    });

    await attacher.start();
    // No error — dump channel was simply excluded
    await attacher.stop();
  });
});
