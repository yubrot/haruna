/**
 * Shared test utilities for channel implementations.
 *
 * Provides factory functions for creating test data ({@link Frame})
 * and mock {@link SendSceneInput} implementations.
 *
 * @module
 */

import type { SceneEvent, SceneInput } from "../scene/interface.ts";
import { snapshot } from "../vt/__testing.ts";
import type { Frame, SendSceneInput } from "./interface.ts";

/**
 * Create a send callback that collects received inputs for later assertion.
 *
 * @returns An object with the collected `inputs` array and the `send` callback to pass to channels
 */
export function collectingSend(): {
  inputs: SceneInput[];
  send: SendSceneInput;
} {
  const inputs: SceneInput[] = [];
  return {
    inputs,
    send(input) {
      inputs.push(input);
    },
  };
}

/**
 * Create a {@link Frame} for testing.
 *
 * String entries are converted to `message_created` events;
 * {@link SceneEvent} objects are passed through as-is.
 *
 * @param events - Events to include (strings become `message_created`; defaults to none)
 * @returns A Frame with a default snapshot and the specified events
 */
export function frame(events: (string | SceneEvent)[] = []): Frame {
  return {
    snapshot: snapshot(["hello"]),
    events: events.map((e) =>
      typeof e === "string"
        ? ({ type: "message_created", style: "text", content: [e] } as const)
        : e,
    ),
  };
}

/**
 * Wait for a condition to become true with polling.
 *
 * Useful for testing asynchronous channel behavior (e.g. waiting for
 * client connections or data arrival).
 *
 * @param fn - The condition to check
 * @param timeoutMs - Maximum wait time in milliseconds
 * @param intervalMs - Polling interval in milliseconds
 * @throws When the condition is not met within the timeout
 */
export async function waitFor(fn: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(intervalMs);
  }
}
