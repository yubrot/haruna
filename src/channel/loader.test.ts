import { describe, expect, test } from "bun:test";
import type { ChannelEntry } from "../config.ts";
import { DumpChannel } from "./dump.ts";
import { type ChannelConfig, loadChannels } from "./loader.ts";
import { WebChannel } from "./web/index.ts";

describe("loadChannels", () => {
  const baseConfig: ChannelConfig = {
    _mode: "exec",
    _command: ["echo"],
  };

  test("creates dump channel with default dir", () => {
    const entries: ChannelEntry[] = [{ name: "dump" }];
    const channels = loadChannels(entries, baseConfig);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toBeInstanceOf(DumpChannel);
  });

  test("creates web channel", () => {
    const entries: ChannelEntry[] = [
      { name: "web", port: 0, host: "127.0.0.1" },
    ];
    const channels = loadChannels(entries, baseConfig);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toBeInstanceOf(WebChannel);
  });

  test("skips dump channel in replay mode", () => {
    const entries: ChannelEntry[] = [{ name: "dump" }];
    const channels = loadChannels(entries, { ...baseConfig, _mode: "replay" });
    expect(channels).toHaveLength(0);
  });

  test("creates multiple channels", () => {
    const entries: ChannelEntry[] = [
      { name: "dump" },
      { name: "web", port: 0, host: "127.0.0.1" },
    ];
    const channels = loadChannels(entries, baseConfig);
    expect(channels).toHaveLength(2);
  });
});
