/**
 * Channel loading — instantiates {@link Channel} objects from
 * configuration entries.
 *
 * @module
 */

import { resolve } from "node:path";
import type { ChannelEntry } from "../config.ts";
import { DumpChannel } from "./dump.ts";
import type { Channel } from "./interface.ts";

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
 * exclusion during replay) is handled here.
 *
 * @param entries - Channel entries from the configuration
 * @param config - Shared runtime configuration
 * @returns Instantiated channel objects (not yet started)
 */
export function loadChannels(
  entries: ChannelEntry[],
  config: ChannelConfig,
): Channel[] {
  const channels: Channel[] = [];
  for (const entry of entries) {
    switch (entry.name) {
      case "dump": {
        if (config._mode === "replay") break;
        const filePath =
          entry.path ??
          resolve(entry.dir ?? ".haruna-dump", `${Date.now()}.dump`);
        channels.push(new DumpChannel({ filePath, command: config._command }));
        break;
      }
    }
  }
  return channels;
}
