/**
 * Replay command — reads a binary dump file and re-runs the event pipeline.
 *
 * @module
 */

import { Attacher } from "../attacher.ts";
import type { Config } from "../config.ts";
import { DumpReader } from "../dump/reader.ts";
import { Session } from "../session.ts";

/**
 * Run the replay command with channels from configuration.
 *
 * Reads snapshots from a binary dump file and processes them through a
 * {@link Session}. Uses {@link Attacher} to wire scenes and channels from
 * config (excluding dump channels), replays the file, then cleans up.
 *
 * @param file - Path to the dump file to replay
 * @param config - Resolved configuration
 * @returns The exit code (0 on success, 1 on error)
 */
export async function runReplay(file: string, config: Config): Promise<number> {
  const session = new Session();
  const attacher = new Attacher(session, {
    sceneConfig: { _mode: "replay", _command: [] },
    channelConfig: { _mode: "replay", _command: [] },
  });

  const hasChannels = config.channels.some((c) => c.type !== "dump");
  if (hasChannels) {
    console.error("[haruna] waiting for client connection...");
  }

  await attacher.apply(config);

  if (hasChannels) {
    console.error("[haruna] client connected, starting replay");
  }

  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) {
      throw new Error(`Dump file not found: ${file}`);
    }

    const reader = await DumpReader.open(file);
    for (const { snapshot } of reader.snapshots()) session.update(snapshot);
  } catch (e) {
    console.error(`[haruna] ${e instanceof Error ? e.message : e}`);
    return 1;
  } finally {
    await attacher.apply(null);
  }
  return 0;
}
