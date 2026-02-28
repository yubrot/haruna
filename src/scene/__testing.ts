/**
 * Shared test utilities for scene recognition testing.
 *
 * @module
 */

import { expect } from "bun:test";
import { DumpReader } from "../dump/reader.ts";
import { richTextToPlainText } from "../vt/snapshot.ts";
import { CompositeScene } from "./builtin/composite.ts";
import type { Scene, SceneEvent } from "./interface.ts";

/**
 * A single entry from {@link traceScene}, capturing the scene's state,
 * continuation firmness, and emitted events for one snapshot.
 */
export interface TraceEntry {
  /** Scene state after processing this snapshot (`null` when inactive). */
  state: string | null;
  /**
   * Whether this result is firm (no preemption attempted).
   *
   * `true` when the snapshot was freshly detected or continued with firm
   * continuation. `false` when the continuation was tentative or no scene
   * matched.
   */
  firm: boolean;
  /** Events emitted for this snapshot. */
  events: SceneEvent[];
}

/**
 * Feed all snapshots from a dump file through a scene and collect
 * per-snapshot trace entries including state and firmness.
 *
 * See `src/scene/builtin/shell.test.ts` for usage examples.
 *
 * @param scene - The scene instance to trace
 * @param dumpPath - Path to a `.dump` file recorded by `haruna record`
 * @returns One {@link TraceEntry} per snapshot in the dump
 */
export async function traceScene(
  scene: Scene,
  dumpPath: string,
): Promise<TraceEntry[]> {
  const reader = await DumpReader.open(dumpPath);
  const composite = new CompositeScene([scene]);
  const result: TraceEntry[] = [];

  for (const { snapshot } of reader.snapshots()) {
    const { events, firm } = composite.process(snapshot);
    result.push({ state: composite.state, firm, events });
  }

  return result;
}

/** Event types whose `content` field holds `RichText[]`. */
const CONTENT_EVENT_TYPES = new Set([
  "message_created",
  "last_message_updated",
]);

/**
 * Replace `RichText[]` content with `string[]` in message events.
 *
 * Converts `message_created` and `last_message_updated` events so that
 * their `content` fields become plain `string[]`, enabling direct
 * structural matching with helpers like {@link block}, {@link text},
 * {@link blockContaining}, and {@link textContaining}.
 *
 * @param trace - Trace entries from {@link traceScene}
 * @returns A copy with plain-text message content
 */
export function simplifyTraceContent(trace: TraceEntry[]): TraceEntry[] {
  return trace.map((t) => ({
    ...t,
    events: t.events.map((e) => {
      if (!CONTENT_EVENT_TYPES.has(e.type)) return e;
      if (!("content" in e) || !Array.isArray(e.content)) return e;
      return { ...e, content: e.content.map(richTextToPlainText) };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Event matchers — partial objects for use with toMatchObject on
// simplifyTraceContent()-converted traces.
// ---------------------------------------------------------------------------

/**
 * Partial event object matching a "text"-style message with exact content.
 *
 * @param lines - Expected plain-text lines (exact, in order)
 */
export function text(...lines: string[]) {
  return { style: "text", content: lines };
}

/**
 * Partial event object matching a "text"-style message that includes all
 * the given lines (in any position).
 *
 * @param lines - Lines that must appear somewhere in the content
 */
export function textContaining(...lines: string[]) {
  return { style: "text", content: expect.arrayContaining(lines) };
}

/**
 * Partial event object matching a "text"-style message where at least one
 * line matches the given regex.
 *
 * @param pattern - Regex to test against content lines
 */
export function textMatching(pattern: RegExp) {
  return {
    style: "text",
    content: expect.arrayContaining([expect.stringMatching(pattern)]),
  };
}

/**
 * Partial event object matching a "block"-style message with exact content.
 *
 * @param lines - Expected plain-text lines (exact, in order)
 */
export function block(...lines: string[]) {
  return { style: "block", content: lines };
}

/**
 * Partial event object matching a "block"-style message that includes all
 * the given lines (in any position).
 *
 * @param lines - Lines that must appear somewhere in the content
 */
export function blockContaining(...lines: string[]) {
  return { style: "block", content: expect.arrayContaining(lines) };
}

/**
 * Partial event object matching a "block"-style message where at least one
 * line matches the given regex.
 *
 * @param pattern - Regex to test against content lines
 */
export function blockMatching(pattern: RegExp) {
  return {
    style: "block",
    content: expect.arrayContaining([expect.stringMatching(pattern)]),
  };
}
