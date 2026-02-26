/**
 * Shared test utilities for VT (Virtual Terminal) modules.
 *
 * Provides factory functions for {@link Snapshot} used in tests.
 *
 * @module
 */

import type { RichText, Snapshot } from "./snapshot.ts";

/**
 * Create a {@link Snapshot} for testing.
 *
 * @param lines - Array of lines (defaults to `["hello"]`)
 * @param overrides - Partial snapshot fields to override defaults
 * @returns A snapshot with sensible defaults, customizable via overrides
 */
export function snapshot(
  lines: RichText[] = ["hello"],
  overrides: Partial<Omit<Snapshot, "lines">> = {},
): Snapshot {
  return {
    cursor: { x: 0, y: 0, visible: true },
    cols: 80,
    rows: 24,
    alternate: false,
    linesOffset: 0,
    timestamp: 1000,
    lines,
    ...overrides,
  };
}
