/**
 * Scene interface, event types, and structured input definitions.
 *
 * @module
 */

import * as v from "valibot";
import type { RichText, Snapshot } from "../vt/snapshot.ts";

/**
 * A scene classifies VT snapshots and emits structured events.
 *
 * Scenes are tried in priority order. The orchestrator calls `continue()`
 * on the active scene first; if it returns `null` or a tentative result
 * (`firm: false`), other scenes' `detect()` is tried for preemption.
 */
export interface Scene {
  /** Lower numbers are tried first. */
  readonly priority: number;

  /**
   * Human-readable description of the scene's current state.
   *
   * Returns `null` when the scene is not active or has no meaningful state.
   * The format is implementation-defined and intended for diagnostics
   * (e.g. `"zsh(echo)"`, `"claude-code(thinking)"`).
   */
  readonly state: string | null;

  /**
   * Pattern check against a snapshot.
   *
   * Called on inactive scenes during clean detection and preemption scans.
   *
   * @param snapshot - The current VT snapshot
   * @returns SceneEvent[] if recognized (may be empty), `null` if not
   */
  detect(snapshot: Snapshot): SceneEvent[] | null;

  /**
   * Continuation check.
   *
   * Called on the active scene to determine whether it is still applicable.
   * Returns `null` to release (continuation failed), or a
   * {@link SceneContinuation} with the emitted events and a `firm` flag.
   *
   * @param snapshot - The current VT snapshot
   * @returns Continuation result, or `null` to release
   */
  continue(snapshot: Snapshot): SceneContinuation | null;

  /**
   * Translate channel input into raw PTY bytes.
   *
   * Called on the active scene when a channel sends input. Returns the
   * byte string to write to the PTY, or `null` to decline (fall through
   * to default handling).
   *
   * @param input - The structured input from a channel
   * @returns Raw bytes to write to the PTY, or `null` to decline
   */
  encodeInput?(input: SceneInput): string | null;
}

/**
 * Result of a scene's {@link Scene.continue} method.
 */
export interface SceneContinuation {
  events: SceneEvent[];
  /**
   * When `true`, the orchestrator skips preemption and trusts this
   * continuation unconditionally. When `false`, other scenes' `detect()`
   * is tried to allow preemption by a more specific scene.
   */
  firm: boolean;
}

/**
 * Check whether a value satisfies the {@link Scene} interface shape.
 *
 * @param value - The value to check
 * @returns `true` if the value has the required Scene properties
 */
export function isScene(value: unknown): value is Scene {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.priority === "number" &&
    typeof obj.detect === "function" &&
    typeof obj.continue === "function" &&
    "state" in obj
  );
}

/**
 * A scene definition: either a {@link Scene} object or a factory function
 * that receives a {@link SceneConfig} and returns one.
 *
 * Built-in scenes and file-based scene modules both conform to this type.
 */
export type SceneFactory = Scene | ((config: SceneConfig) => Scene);

/**
 * Configuration passed to scene factory functions during initialization.
 *
 * Reserved keys (prefixed with `_`) carry runtime information from the
 * haruna; additional keys come from per-scene configuration entries.
 */
export interface SceneConfig {
  /** Operating mode (`"exec"` or `"replay"`). */
  _mode: "exec" | "replay";
  /** The command being executed. */
  _command: string[];
  /** Per-scene configuration properties. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SceneEvent
// ---------------------------------------------------------------------------

/** Union of all scene event types. */
export type SceneEvent =
  | SceneStateChanged
  | IndicatorChanged
  | MessageCreated
  | LastMessageUpdated
  | InputChanged
  | QuestionCreated
  | LastQuestionUpdated
  | PermissionRequired;

/** The active scene changed (or became inactive). */
export interface SceneStateChanged {
  type: "scene_state_changed";
  /** Name of the now-active scene, or `null` when no scene is active. */
  state: string | null;
}

/** The indicator (spinner) appeared, disappeared, or changed text. */
export interface IndicatorChanged {
  type: "indicator_changed";
  /** Whether an indicator is now active. */
  active: boolean;
  /** Current indicator text (empty when `active` is `false`). */
  text: string;
}

/** A new message appeared in the scene. */
export interface MessageCreated {
  type: "message_created";
  /** Visual style of the message. */
  style: "text" | "block";
  /** Lines of rich text content. */
  content: RichText[];
  /** When `true`, this message is an echo of user input. */
  echo?: true;
}

/** The last (most recent) message's content changed. */
export interface LastMessageUpdated {
  type: "last_message_updated";
  /** Visual style of the message. */
  style: "text" | "block";
  /** Updated lines of rich text content, or `null` when the message was deleted. */
  content: RichText[] | null;
  /** When `true`, this message is an echo of user input. */
  echo?: true;
}

/** The input field appeared, disappeared, or changed text. */
export interface InputChanged {
  type: "input_changed";
  /** Whether an input field is now active. */
  active: boolean;
  /** Current input text (empty when `active` is `false`). */
  text: string;
}

/** A new question appeared in the scene. */
export interface QuestionCreated {
  type: "question_created";
  /** Optional header text above the question. */
  header?: string;
  /** The question text. */
  question: string;
  /** Available options. */
  options: { label: string; description?: string }[];
  /** 0-based index of the currently selected option. */
  selected?: number;
}

/** The last (most recent) question's content changed. */
export interface LastQuestionUpdated {
  type: "last_question_updated";
  /** Optional header text above the question. */
  header?: string;
  /** The question text. */
  question: string;
  /** Available options. */
  options: { label: string; description?: string }[];
  /** 0-based index of the currently selected option. */
  selected?: number;
}

/** A tool-execution permission prompt appeared (immutable once emitted). */
export interface PermissionRequired {
  type: "permission_required";
  /** The command or tool name requesting permission. */
  command: string;
  /** Human-readable description of what the command will do. */
  description?: string;
  /** Available options (e.g. "Allow", "Deny"). */
  options: { label: string; description?: string }[];
  /** 0-based index of the currently selected option. */
  selected?: number;
}

// ---------------------------------------------------------------------------
// SceneInput
// ---------------------------------------------------------------------------

/** Valibot schema for text input. Strips C0 control characters from content. */
const TextSceneInputSchema = v.object({
  type: v.literal("text"),
  content: v.pipe(v.string(), v.transform(stripControlChars)),
});

/** Valibot schema for selection input. Selects an option by 0-based index. */
const SelectSceneInputSchema = v.object({
  type: v.literal("select"),
  index: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/** Valibot schema for the {@link SceneInput} union. */
const SceneInputSchema = v.union([
  TextSceneInputSchema,
  SelectSceneInputSchema,
]);

/** Union of all structured input types sent from channels to the system. */
export type SceneInput = v.InferOutput<typeof SceneInputSchema>;

/**
 * Validate and parse an unknown value into a {@link SceneInput}.
 *
 * When `value` is a string it is first parsed as JSON, so callers can pass
 * a raw JSON Lines string directly without pre-parsing.
 *
 * @param value - The value to validate (an object or a JSON string)
 * @returns The validated SceneInput, or `null` if the value is not valid
 */
export function parseSceneInput(value: unknown): SceneInput | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const result = v.safeParse(SceneInputSchema, value);
  return result.success ? result.output : null;
}

/**
 * Strip ASCII control characters (C0 range and DEL) except tab and newline.
 *
 * CR (`\r`) is also stripped — the gateway appends its own CR when
 * forwarding text input as a submit action.
 *
 * Prevents injection of sequences like Ctrl+C, ESC, or DEL into the PTY
 * when external input is forwarded.
 *
 * @param s - The string to sanitize
 * @returns The sanitized string with control characters removed
 */
function stripControlChars(s: string): string {
  // Since a single regex replace is simpler and faster than a charCode loop,
  // biome-ignore lint/suspicious/noControlCharactersInRegex: is intentional
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
