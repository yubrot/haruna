/**
 * Channel loading — instantiates {@link Channel} objects from
 * configuration entries.
 *
 * @module
 */

import { resolve } from "node:path";
import type { ChannelEntry } from "../config.ts";
import { DiscordChannel } from "./discord/index.ts";
import { DumpChannel } from "./dump/index.ts";
import type { Channel } from "./interface.ts";
import { SlackChannel } from "./slack/index.ts";
import { WebChannel } from "./web/index.ts";

/**
 * Configuration passed to channel constructors during initialization.
 *
 * Carries runtime information shared across all channel types.
 */
export interface ChannelConfig {
  /** Operating mode (`"exec"` or `"replay"`). */
  _mode: "exec" | "replay";
  /** The command being executed. */
  _command: string[];
}

/**
 * Instantiate {@link Channel} objects from configuration entries.
 *
 * Iterates over channel entries and constructs the appropriate channel
 * implementation for each. Mode-dependent logic (e.g. dump channel
 * exclusion during replay, web channel defaults) is handled here.
 *
 * @param entries - Channel entries from the configuration
 * @param config - Shared runtime configuration
 * @returns Instantiated channel objects (not yet started)
 */
export function loadChannels(entries: ChannelEntry[], config: ChannelConfig): Channel[] {
  const channels: Channel[] = [];
  for (const entry of entries) {
    const ch = buildChannel(entry, config);
    if (ch) channels.push(ch);
  }
  return channels;
}

function buildChannel(entry: ChannelEntry, config: ChannelConfig): Channel | null {
  try {
    switch (entry.type) {
      case "web": {
        const defaultWait = config._mode === "replay";
        return new WebChannel({
          port: entry.port,
          host: entry.host,
          waitForClient: entry.waitForClient ?? defaultWait,
        });
      }
      case "dump": {
        if (config._mode === "replay") return null;
        const filePath = entry.path ?? resolve(entry.dir ?? ".haruna-dump", `${Date.now()}.dump`);
        return new DumpChannel({ filePath, command: config._command });
      }
      case "discord":
        return new DiscordChannel(entry);
      case "slack":
        return new SlackChannel(entry);
      default:
        console.error(`[haruna] unknown channel type: ${(entry as { type: string }).type}`);
        return null;
    }
  } catch (e) {
    console.error(`[haruna][${entry.type}] failed to load: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
