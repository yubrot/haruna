/**
 * Content area parsing for the Claude Code scene.
 *
 * Extracts user and AI message chunks from the scrollback region
 * above the input area, tracks updates, and emits scene events.
 *
 * @module
 */

import {
  collectLines,
  getPlainLine,
  type RichText,
  richTextLinesEqual,
  type Snapshot,
} from "../../../vt/snapshot.ts";
import type { SceneEvent } from "../../interface.ts";

/** AI message marker. */
const AI_MESSAGE_MARKER = "●";

/** Committed user message marker in content area. */
const USER_MESSAGE_MARKER = "❯";

/** Separator line pattern (series of ─ characters). */
const SEPARATOR = /^─{8,}$/;

/** Spinner characters used by Claude Code. */
const SPINNER = /^\s*[✢✶✽✻✺·*]\s(.+)/;

/**
 * A parsed chunk from the content area.
 */
export interface ContentChunk {
  /** "user" for ❯-prefixed messages, "ai" for ● messages. */
  kind: "user" | "ai";
  /** Absolute start line index. */
  startLine: number;
  /** Absolute end line index (exclusive). */
  endLine: number;
}

/**
 * A stored chunk with its collected content for update detection.
 */
export interface StoredChunk extends ContentChunk {
  /** Collected content at the time of last emission (for change detection). */
  content: RichText[];
}

/**
 * Parse content chunks iteratively, checking the last stored chunk for
 * updates and emitting new chunks as message_created events.
 *
 * @returns Updated contentStart and lastContentChunk after processing
 */
export function processContentChunks(
  snapshot: Snapshot,
  contentStart: number,
  lastContentChunk: StoredChunk | null,
  contentEnd: number,
  events: SceneEvent[],
): { contentStart: number; lastContentChunk: StoredChunk | null } {
  // Re-check the last emitted chunk for updates (or preserve it if still in buffer)
  const rechecked =
    lastContentChunk && recheckLastChunk(snapshot, lastContentChunk, contentEnd, events);
  const scanFrom = rechecked?.scanFrom ?? contentStart;
  let currentStored = rechecked?.stored ?? null;

  // Iteratively find and emit new chunks
  let parsed = parseContentChunk(snapshot, scanFrom, contentEnd);
  while (parsed) {
    const [chunk, nextLine] = parsed;
    const content = collectLines(snapshot, chunk.startLine, chunk.endLine);
    const event: SceneEvent = {
      type: "message_created",
      style: "block",
      content,
    };
    if (chunk.kind === "user") event.echo = true;
    events.push(event);
    currentStored = { ...chunk, content };
    parsed = parseContentChunk(snapshot, nextLine, contentEnd);
  }

  // Rewind to the last chunk's start so recheckLastChunk can re-read it next frame
  const newContentStart = currentStored?.startLine ?? contentStart;
  return { contentStart: newContentStart, lastContentChunk: currentStored };
}

/**
 * Find the last spinner line above `contentEnd` within a fixed window.
 *
 * @returns The spinner text (without the spinner character), or `null`
 */
export function findSpinner(snapshot: Snapshot, contentEnd: number): string | null {
  const offset = snapshot.linesOffset ?? 0;
  const stop = Math.max(offset, contentEnd - 10);
  for (let abs = contentEnd - 1; abs >= stop; abs--) {
    const text = getPlainLine(snapshot, abs);
    const m = text.match(SPINNER);
    if (m) return m[1] ?? null;
  }
  return null;
}

/**
 * Parse a single content chunk starting at or after `from`.
 *
 * Scans forward from `from` looking for a user (❯) or AI (●) message
 * marker. When found, determines the chunk's end via {@link findChunkEnd}.
 *
 * @param snapshot - Current terminal snapshot
 * @param from - Absolute line index to start scanning from
 * @param contentEnd - Absolute line index where content ends (exclusive)
 * @returns A tuple of [chunk, nextLineIndex] or `null` if no chunk is found
 */
function parseContentChunk(
  snapshot: Snapshot,
  from: number,
  contentEnd: number,
): [ContentChunk, number] | null {
  for (let i = from; i < contentEnd; i++) {
    const text = getPlainLine(snapshot, i);
    const kind = text.startsWith(USER_MESSAGE_MARKER)
      ? "user"
      : text.startsWith(AI_MESSAGE_MARKER)
        ? "ai"
        : null;
    if (kind) {
      const endLine = findChunkEnd(snapshot, i + 1, contentEnd);
      return [{ kind, startLine: i, endLine }, endLine];
    }
  }
  return null;
}

/** Scan forward from `i` until hitting a boundary marker (message marker, separator, or spinner). */
function findChunkEnd(snapshot: Snapshot, i: number, end: number): number {
  while (i < end) {
    const nextText = getPlainLine(snapshot, i);
    if (
      nextText.startsWith(AI_MESSAGE_MARKER) ||
      nextText.startsWith(USER_MESSAGE_MARKER) ||
      SEPARATOR.test(nextText) ||
      SPINNER.test(nextText)
    )
      break;
    i++;
  }
  return i;
}

/**
 * Re-parse the last emitted chunk and emit an update event if its content changed.
 *
 * When the chunk is still in the buffer but its marker is temporarily invisible
 * (e.g. during permission/question/plan_review overlays), preserves the chunk
 * and advances past its end to avoid re-emitting the same content as a new message.
 *
 * @returns The scan position after the chunk and the (possibly updated) stored chunk,
 *          or `null` if the chunk has scrolled out of the buffer.
 */
function recheckLastChunk(
  snapshot: Snapshot,
  prevStored: StoredChunk,
  contentEnd: number,
  events: SceneEvent[],
): { scanFrom: number; stored: StoredChunk } | null {
  const offset = snapshot.linesOffset ?? 0;
  if (prevStored.startLine < offset) return null;

  const result = parseContentChunk(snapshot, prevStored.startLine, contentEnd);
  if (!result) {
    // Marker temporarily invisible but chunk still in buffer — preserve it
    return { scanFrom: prevStored.endLine, stored: prevStored };
  }

  const [chunk, nextLine] = result;
  const content = collectLines(snapshot, chunk.startLine, chunk.endLine);
  if (!richTextLinesEqual(prevStored.content, content)) {
    const event: SceneEvent = {
      type: "last_message_updated",
      style: "block",
      content,
    };
    if (chunk.kind === "user") event.echo = true;
    events.push(event);
    return { scanFrom: nextLine, stored: { ...chunk, content } };
  }
  return { scanFrom: nextLine, stored: prevStored };
}
