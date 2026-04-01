/**
 * Gateway loading — instantiates {@link Gateway} objects from
 * configuration entries.
 *
 * @module
 */

import type { GatewayEntry } from "../config.ts";
import type { Gateway } from "./interface.ts";

/**
 * Instantiate {@link Gateway} objects from configuration entries.
 *
 * @param entries - Gateway entries from the configuration
 * @returns Instantiated gateway objects (not yet started)
 */
export function loadGateways(entries: GatewayEntry[]): Gateway[] {
  const gateways: Gateway[] = [];
  for (const entry of entries) {
    const gw = buildGateway(entry);
    if (gw) gateways.push(gw);
  }
  return gateways;
}

function buildGateway(entry: GatewayEntry): Gateway | null {
  try {
    switch (entry.type) {
      default:
        console.error(`[haruna] unknown gateway type: ${(entry as { type: string }).type}`);
        return null;
    }
  } catch (e) {
    console.error(`[haruna][${entry.type}] failed to load: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
