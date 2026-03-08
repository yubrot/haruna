/**
 * Replay command — reads a binary dump file and re-runs the event pipeline.
 *
 * @module
 */

import type { Config } from "../config.ts";
import { DumpReader } from "../dump/reader.ts";
import { Relay, RelayConfigurator } from "../relay.ts";

/**
 * Run the replay command with channels from configuration.
 *
 * @param file - Path to the dump file to replay
 * @param config - Resolved configuration
 * @returns The exit code (0 on success, 1 on error)
 */
export async function runReplay(file: string, config: Config): Promise<number> {
  const relay = new Relay();

  try {
    await new RelayConfigurator(relay, { mode: "replay", command: [] }).apply(config);

    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) {
      throw new Error(`Dump file not found: ${file}`);
    }

    const reader = await DumpReader.open(file);
    for (const { snapshot } of reader.snapshots()) relay.update(snapshot);
  } catch (e) {
    console.error(`[haruna] ${e instanceof Error ? e.message : e}`);
    return 1;
  } finally {
    await relay.dispose().catch(() => {});
  }
  return 0;
}
