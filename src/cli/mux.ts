/**
 * Mux command — run multiple sessions driven by gateways.
 *
 * @module
 */

import type { Config } from "../config.ts";
import { Multiplexer, MultiplexerConfigurator } from "../multiplexer.ts";
import { FileWatch } from "../util/file.ts";

const KILL_TIMEOUT_MS = 10_000;

/**
 * Run the multiplexer with gateways from configuration.
 *
 * @param config - Base configuration (before init resolution)
 * @returns Exit code (0 for clean shutdown)
 */
export async function runMux(config: Config): Promise<number> {
  const mux = new Multiplexer({ config });
  const configurator = new MultiplexerConfigurator(mux);

  const fileWatch = new FileWatch(async () => {
    try {
      await mux.reloadConfig();
      await configurator.apply(mux.config);
      fileWatch.update(await mux.config.fileWatchTargets());
    } catch (e) {
      console.error(`[haruna] config reload failed: ${e instanceof Error ? e.message : e}`);
    }
  });
  fileWatch.update(await mux.config.fileWatchTargets());

  await configurator.apply(config);

  console.error(`[haruna] Multiplexer running. Press Ctrl+C to stop.`);

  // Wait for first shutdown signal
  await new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });

  console.error("[haruna] Shutting down (SIGTERM to sessions)...");
  fileWatch.close();
  mux.killAll("SIGTERM");

  // During disposal: second signal → immediate SIGKILL + force exit
  const onForceSignal = () => {
    console.error("[haruna] Forced shutdown (SIGKILL to sessions).");
    mux.killAll("SIGKILL");
    process.exit(1);
  };
  process.on("SIGINT", onForceSignal);
  process.on("SIGTERM", onForceSignal);

  // Escalate to SIGKILL after timeout
  const killTimer = setTimeout(() => {
    console.error("[haruna] Graceful shutdown timed out, sending SIGKILL...");
    mux.killAll("SIGKILL");
  }, KILL_TIMEOUT_MS);

  await mux.dispose();

  clearTimeout(killTimer);
  process.off("SIGINT", onForceSignal);
  process.off("SIGTERM", onForceSignal);

  return 0;
}
