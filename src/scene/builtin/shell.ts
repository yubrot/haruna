/**
 * Shell scene — recognizes interactive shell prompts and emits events
 * for command execution, output, and input state changes.
 *
 * @module
 */

import {
  collectLines,
  cursorLineIndex,
  getLine,
  richTextToPlainText,
  type Snapshot,
} from "../../vt/snapshot.ts";
import type {
  Scene,
  SceneConfig,
  SceneContinuation,
  SceneEvent,
} from "../interface.ts";

/**
 * Internal state of the shell scene.
 *
 * All positions are absolute (snapshot-relative index + `linesOffset`).
 */
type ShellState =
  | {
      /** Prompt is visible and the shell is waiting for input. */
      type: "idle";
      /** Absolute index of the first line of the prompt block. */
      promptStart: number;
      /** Absolute index of the prompt marker line. */
      promptEnd: number;
    }
  | {
      /** Prompt no longer matches at the cursor line; a command is executing. */
      type: "running";
      /** Absolute index up to which output has been emitted. */
      emittedUpTo: number;
    };

/**
 * Shell scene that recognizes interactive shell prompts via a configurable
 * regular expression and emits {@link SceneEvent}s as the user types commands
 * and receives output.
 */
class ShellScene implements Scene {
  readonly priority = 100;

  private readonly promptMatcher: PromptMatcher;
  private shellState: ShellState | null = null;

  constructor(config: SceneConfig) {
    this.promptMatcher = new PromptMatcher(config);
  }

  get state(): string | null {
    if (!this.shellState) return null;
    return `shell(${this.shellState.type})`;
  }

  detect(snapshot: Snapshot): SceneEvent[] | null {
    const prompt = this.promptMatcher.match(snapshot);
    if (!prompt || !prompt.isFirm) return null;

    return this.idle(prompt, []).events;
  }

  private reDetect(snapshot: Snapshot): SceneContinuation | null {
    this.shellState = null;

    const prompt = this.promptMatcher.match(snapshot);
    if (!prompt || !prompt.isFirm) return null;

    // NOTE: Lines above the prompt (prior command output) are discarded
    // because we have no reliable absolute positions to emit them.
    // An alternative would be to emit the visible viewport as output,
    // but that risks duplicating already-emitted content.
    return this.idle(prompt, []);
  }

  continue(snapshot: Snapshot): SceneContinuation | null {
    if (!this.shellState) return null;

    // Alternate screen (e.g. pager): preserve state, emit nothing.
    if (snapshot.alternate) return { events: [], firm: false };

    // Absolute coordinates are unreliable when tracking is lost
    // (linesOffset == null). Reset state and attempt re-detection.
    if (snapshot.linesOffset == null) return this.reDetect(snapshot);

    // When the snapshot's addressable range no longer covers our tracked
    // positions (e.g. after resize), reset state and attempt re-detection.
    const snapshotEnd = snapshot.linesOffset + snapshot.lines.length;
    // Minimum snapshotEnd required to keep tracking:
    const requiredEnd =
      this.shellState.type === "idle"
        ? this.shellState.promptEnd + 1
        : this.shellState.emittedUpTo;
    if (snapshotEnd < requiredEnd) return this.reDetect(snapshot);

    const events: SceneEvent[] = [];
    const prompt = this.promptMatcher.match(snapshot);

    if (this.shellState.type === "idle") {
      if (prompt && prompt.promptEnd === this.shellState.promptEnd) {
        // Prompt didn't move — only input text may have changed
        return this.idle(prompt, events);
      }

      // Prompt disappeared or moved — idle => running.
      // Emit the prompt block immediately before transitioning so that
      // the running state only needs to track command output.
      events.push({ type: "input_changed", active: false, text: "" });

      // Only emit when the entire prompt block is still visible.
      if (this.shellState.promptStart >= snapshot.linesOffset) {
        events.push({
          type: "message_created",
          style: "block",
          content: collectLines(
            snapshot,
            this.shellState.promptStart,
            this.shellState.promptEnd + 1,
          ),
          echo: true,
        });
      }

      this.shellState = {
        type: "running",
        emittedUpTo: this.shellState.promptEnd + 1,
      };
    }

    const boundary = prompt
      ? prompt.promptStart
      : snapshot.linesOffset + snapshot.lines.length;

    // Content before offset has scrolled out of the snapshot and is
    // no longer accessible; advance past it.
    if (this.shellState.emittedUpTo < snapshot.linesOffset) {
      this.shellState.emittedUpTo = snapshot.linesOffset;
    }

    // Committed command output
    if (this.shellState.emittedUpTo < boundary) {
      events.push({
        type: "message_created",
        style: "text",
        content: collectLines(snapshot, this.shellState.emittedUpTo, boundary),
      });

      this.shellState.emittedUpTo = boundary;
    }

    // If prompt returned, settle back to idle
    if (prompt) return this.idle(prompt, events);

    return { events, firm: false };
  }

  /** Transition to idle state, emitting input_changed and updating internal state. */
  private idle(prompt: PromptMatch, events: SceneEvent[]): SceneContinuation {
    events.push({
      type: "input_changed",
      active: true,
      text: prompt.inputText,
    });
    this.shellState = {
      type: "idle",
      promptStart: prompt.promptStart,
      promptEnd: prompt.promptEnd,
    };
    return { events, firm: prompt.isFirm };
  }
}

/**
 * Result of a successful prompt match against a snapshot.
 *
 * All positions are absolute (snapshot-relative index + `linesOffset`).
 */
interface PromptMatch {
  /** Absolute index of the first line of the prompt block. */
  promptStart: number;
  /** Absolute index of the prompt marker line. */
  promptEnd: number;
  /** Trimmed text after the prompt pattern (user input so far). */
  inputText: string;
  /** Whether a matched prompt should be considered a firm (decisive) match. */
  isFirm: boolean;
}

/**
 * Matches an interactive shell prompt in a terminal snapshot.
 *
 * Only inspects the single cursor line (plus an optional prefix line above
 * it), so a match requires the cursor and the prompt marker to be on the
 * same line. When the user's input spans multiple lines — either by explicit
 * continuation (`\` + PS2 prompt) or by soft-wrapping past the terminal
 * width — the cursor moves off the prompt line and {@link match} returns
 * `null`. The caller ({@link ShellScene}) then misinterprets the state as
 * "running": the prompt line is emitted as a committed block message, and
 * the continuation / wrapped lines appear as command output via
 * `message_created` / `last_message_updated`.
 */
class PromptMatcher {
  private readonly pattern: RegExp;
  private readonly prefixPattern: RegExp | null;

  /**
   * @param config - Scene configuration.
   *   `prompt` (string) sets the prompt regex source (default `"^\\$"`).
   *   `promptPrefix` (string, optional) sets a regex that must match the line
   *   immediately above the prompt marker line for multi-line prompt support.
   */
  constructor(config: SceneConfig) {
    this.pattern = safeRegExp(config.prompt, /^\$/);
    this.prefixPattern =
      typeof config.promptPrefix === "string"
        ? safeRegExp(config.promptPrefix, null)
        : null;
  }

  /**
   * Try to match the prompt pattern on the cursor line.
   *
   * Returns absolute positions via {@link cursorLineIndex}.
   * Returns `null` when no prompt is found.
   */
  match(snapshot: Snapshot): PromptMatch | null {
    if (!snapshot.cursor.visible) return null;

    const idx = cursorLineIndex(snapshot);
    const cursorLine = getLine(snapshot, idx);
    if (!cursorLine) return null;

    const line = richTextToPlainText(cursorLine);
    const m = line.match(this.pattern);
    if (!m) return null;

    // Multi-line prompt: verify the line above matches the prefix pattern
    if (this.prefixPattern) {
      const aboveLine = getLine(snapshot, idx - 1);
      if (!aboveLine) return null;
      if (!this.prefixPattern.test(richTextToPlainText(aboveLine))) return null;
    }

    return {
      promptStart: this.prefixPattern ? idx - 1 : idx,
      promptEnd: idx,
      inputText: line.slice(m[0].length).trim(),
      // Defensively, checking whether the cursor sits on the last line would
      // prevent false positives when another tool's output happens to match the
      // prompt pattern at the cursor line. However, legitimate shell UI such as
      // tab-completion candidates appears below the prompt and would cause
      // false negatives (firm:false), leading to unwanted preemption. Since
      // cursor-visible + prompt-match is already a strong signal, we
      // unconditionally return true.
      isFirm: true,
    };
  }
}

/**
 * Compile a user-supplied regex source, falling back to a default on invalid input.
 *
 * @param source - Value from SceneConfig (expected to be a string regex source)
 * @param fallback - RegExp to use when `source` is not a string or is invalid
 * @returns Compiled RegExp
 */
function safeRegExp<T extends RegExp | null>(
  source: unknown,
  fallback: T,
): RegExp | T {
  if (typeof source !== "string") return fallback;
  try {
    return new RegExp(source);
  } catch {
    return fallback;
  }
}

export default (config: SceneConfig) => new ShellScene(config);
