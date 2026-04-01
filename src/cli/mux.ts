/**
 * Mux command — run multiple sessions driven by gateways.
 *
 * @module
 */

import type { Config } from "../config.ts";
import { Multiplexer, MultiplexerConfigurator } from "../multiplexer.ts";
import { FileWatch } from "../util/file.ts";

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

  // Wait for shutdown signal
  const exitSignal = await new Promise<string>((resolve) => {
    const onSigint = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve("SIGINT");
    };
    const onSigterm = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve("SIGTERM");
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });

  console.error(`[haruna] Received ${exitSignal}, shutting down...`);
  fileWatch.close();
  await mux.dispose();
  return 0;
}
