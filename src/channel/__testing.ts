/**
 * Shared test utilities for channel implementations.
 *
 * Provides factory functions for creating test data ({@link Frame})
 * and mock {@link SendSceneInput} implementations.
 *
 * @module
 */

import type { SceneInput } from "../scene/interface.ts";
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
 * Each string in `messages` becomes a `message_created` event.
 *
 * @param messages - Messages to include as scene events (defaults to none)
 * @returns A Frame with a default snapshot and the specified message events
 */
export function frame(messages: string[] = []): Frame {
  return {
    snapshot: snapshot(["hello"]),
    events: messages.map(
      (content) =>
        ({
          type: "message_created",
          style: "text",
          content: [content],
        }) as const,
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
export async function waitFor(
  fn: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(intervalMs);
  }
}
