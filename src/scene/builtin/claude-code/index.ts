/**
 * Claude Code scene — recognizes Claude Code's TUI and emits events
 * for messages, tool use, questions, and indicator state changes.
 *
 * @module
 */

import type { Snapshot } from "../../../vt/snapshot.ts";
import type {
  InputAction,
  Scene,
  SceneConfig,
  SceneContinuation,
  SceneEvent,
  SceneInput,
} from "../../interface.ts";
import { findSpinner, processContentChunks, type StoredChunk } from "./content-area.ts";
import {
  findInputArea,
  type InputArea,
  type InputFree,
  type InputPermission,
  type InputPlanReview,
  type InputQuestion,
} from "./input-area.ts";

/** Delay (ms) before CR so Ink treats text and submit as separate events. */
const CR_DELAY_MS = 50;

/** Delay (ms) after sending a number key for option selection to settle. */
const SELECT_SETTLE_MS = 50;

/** Delay (ms) after ESC to let the overlay dismiss before typing. */
const ESC_SETTLE_MS = 300;

/**
 * Internal state of the Claude Code scene.
 *
 * All positions are absolute (snapshot-relative index + `linesOffset`).
 */
type CCState = IdleState | RespondingState;

/** Idle state — input area visible, waiting for user action. */
interface IdleState {
  type: "idle";
  /** Last known input text, or `null` on initial detection (forces emission). */
  inputText: string | null;
  /** Last known question text for detecting question changes in multi-question flows. */
  questionText: string | null;
  /** Current input state (what is displayed in the input area). */
  inputState: InputState;
  /** Number of options in the current question/permission/plan_review UI (0 when free). */
  optionCount: number;
}

/** What is displayed in the input area during idle state. */
type InputState = "free" | "question" | "permission" | "plan_review";

function idleState(overrides: Partial<Omit<IdleState, "type">>): IdleState {
  return {
    type: "idle",
    inputText: "",
    questionText: null,
    inputState: "free",
    optionCount: 0,
    ...overrides,
  };
}

/** Responding state — Claude is generating a response. */
interface RespondingState {
  type: "responding";
}

/**
 * Claude Code scene that recognizes the Claude Code TUI and emits
 * semantic events for messages, questions, indicators, and input state.
 */
class ClaudeCodeScene implements Scene {
  readonly priority = 50;

  private ccState: CCState | null = null;
  /** Scan start position for content parsing. */
  private contentStart = 0;
  /** Last emitted chunk with its content, or `null` when none emitted yet. */
  private lastContentChunk: StoredChunk | null = null;
  /** Last emitted indicator text (shared across states, for dedup). */
  private lastIndicator = "";

  get state(): string | null {
    if (!this.ccState) return null;
    if (this.ccState.type === "idle") {
      return `claude-code(${this.ccState.inputState})`;
    }
    return `claude-code(${this.ccState.type})`;
  }

  get isIdle(): boolean {
    return this.ccState?.type === "idle";
  }

  detect(snapshot: Snapshot): SceneEvent[] | null {
    if (snapshot.alternate) return null;

    const inputArea = findInputArea(snapshot);
    if (!inputArea) return null;

    const result = this.resetContinue(snapshot, inputArea);
    if (!result) return null;
    return result.events;
  }

  /**
   * Reset content tracking and re-run continuation from a known input area.
   *
   * Used by both initial detection and recovery from stale state (e.g. /clear).
   */
  private resetContinue(snapshot: Snapshot, inputArea: InputArea): SceneContinuation | null {
    // Initialize with contentStart = upperSep so the [contentStart, upperSep)
    // range is empty — no content parsing on re-detect.
    this.ccState = idleState({ inputText: null });
    this.contentStart = inputArea.upperSep;
    this.lastContentChunk = null;
    this.lastIndicator = "";

    const result = this.continue(snapshot);
    if (!result) this.ccState = null;
    return result;
  }

  continue(snapshot: Snapshot): SceneContinuation | null {
    if (!this.ccState) return null;
    if (snapshot.alternate) return { events: [], firm: false };

    const inputArea = findInputArea(snapshot);
    if (!inputArea) return { events: [], firm: false };

    // Content tracking is stale (e.g. /clear reset the screen) — re-detect
    const offset = snapshot.linesOffset ?? 0;
    if (this.contentStart < offset || this.contentStart > inputArea.upperSep) {
      return this.resetContinue(snapshot, inputArea);
    }

    const spinner = findSpinner(snapshot, inputArea.upperSep);
    const isResponding = spinner?.includes("…") ?? false;
    const prevState = this.ccState;
    const events: SceneEvent[] = [];

    // Content processing — skip during interactive persistence to avoid
    // emitting message events while a permission/question prompt is active.
    const isInteractivePersistence =
      prevState.type === "idle" &&
      prevState.inputState !== "free" &&
      inputArea.body.kind === prevState.inputState;

    if (!isInteractivePersistence) {
      const content = processContentChunks(
        snapshot,
        this.contentStart,
        this.lastContentChunk,
        inputArea.upperSep,
        events,
      );
      this.contentStart = content.contentStart;
      this.lastContentChunk = content.lastContentChunk;
    }

    if (inputArea.body.kind === "permission") {
      this.emitPermissionTransition(inputArea.body, prevState, events);
      this.ccState = idleState({
        inputState: "permission",
        optionCount: inputArea.body.options.length,
      });
    } else if (inputArea.body.kind === "plan_review") {
      this.emitPlanReviewTransition(inputArea.body, prevState, events);
      this.ccState = idleState({
        inputState: "plan_review",
        optionCount: inputArea.body.options.length,
      });
    } else if (inputArea.body.kind === "question") {
      this.emitQuestionTransition(inputArea.body, prevState, events);
      this.ccState = idleState({
        questionText: inputArea.body.question,
        inputState: "question",
        optionCount: inputArea.body.options.length,
      });
    } else if (isResponding) {
      this.emitRespondingTransition(prevState, events);
      this.ccState = { type: "responding" };
    } else {
      this.emitFreeTransition(inputArea.body, prevState, events);
      this.ccState = idleState({ inputText: inputArea.body.inputText });
    }

    this.emitIndicatorChange(isResponding, spinner, events);

    return { events, firm: true };
  }

  encodeInput(input: SceneInput): InputAction[] | InputAction | null {
    if (!this.ccState) return null;

    // Responding — only text input is accepted
    if (this.ccState.type === "responding") {
      if (input.type === "text") return [input.content, { sleep: CR_DELAY_MS }, "\r"];
      return null;
    }

    const { inputState, optionCount } = this.ccState;

    if (input.type === "text") {
      if (inputState === "free") return [input.content, { sleep: CR_DELAY_MS }, "\r"];
      // In overlay states, dismiss with ESC before typing
      return ["\x1b", { sleep: ESC_SETTLE_MS }, input.content, { sleep: CR_DELAY_MS }, "\r"];
    }

    // SelectInput — only meaningful when an option list is visible
    if (input.index >= optionCount) return null;
    return [`${input.index + 1}`, { sleep: SELECT_SETTLE_MS }];
  }

  /**
   * Emit events when a permission prompt appears or persists.
   * Skips emission when the previous state already showed a permission overlay.
   */
  private emitPermissionTransition(
    body: InputPermission,
    prevState: CCState,
    events: SceneEvent[],
  ): void {
    if (prevState.type === "idle" && prevState.inputState === "permission") return;
    events.push({
      type: "permission_required",
      command: body.command,
      description: body.description,
      options: body.options,
      selected: body.selected,
    });
    events.push({ type: "input_changed", active: false, text: "" });
  }

  /**
   * Emit events when a plan review UI appears or persists.
   * Emits plan content as a block message and a question for the options.
   * Skips emission when the previous state already showed a plan_review overlay.
   */
  private emitPlanReviewTransition(
    body: InputPlanReview,
    prevState: CCState,
    events: SceneEvent[],
  ): void {
    if (prevState.type === "idle" && prevState.inputState === "plan_review") {
      // Already showing plan review — emit selection update only
      events.push({
        type: "last_question_updated",
        question: body.question,
        options: body.options,
        selected: body.selected,
      });
      return;
    }
    // Emit plan content as a block message
    if (body.planContent.length > 0) {
      events.push({ type: "message_created", style: "block", content: body.planContent });
    }
    // Emit question for plan review options
    events.push({
      type: "question_created",
      question: body.question,
      options: body.options,
      selected: body.selected,
    });
    events.push({ type: "input_changed", active: false, text: "" });
  }

  /** Emit input_changed when transitioning from idle to responding. */
  private emitRespondingTransition(prevState: CCState, events: SceneEvent[]): void {
    if (prevState.type === "idle") {
      events.push({ type: "input_changed", active: false, text: "" });
    }
  }

  /** Emit events when a question UI appears or persists. */
  private emitQuestionTransition(
    body: InputQuestion,
    prevState: CCState,
    events: SceneEvent[],
  ): void {
    if (prevState.type === "responding") {
      events.push({
        type: "question_created",
        question: body.question,
        options: body.options,
        selected: body.selected,
      });
      events.push({ type: "input_changed", active: true, text: "" });
    } else {
      const isNewQuestion =
        prevState.inputState !== "question" || body.question !== prevState.questionText;
      events.push({
        type: isNewQuestion ? "question_created" : "last_question_updated",
        question: body.question,
        options: body.options,
        selected: body.selected,
      });
      // Emit input_changed when entering question from a non-question state
      // (free→question changes inputText, permission/plan_review needs reactivation,
      // first detection has inputText == null)
      if (prevState.inputText == null || prevState.inputState !== "question") {
        events.push({ type: "input_changed", active: true, text: "" });
      }
    }
  }

  /** Emit events when transitioning to or continuing in free input state. */
  private emitFreeTransition(body: InputFree, prevState: CCState, events: SceneEvent[]): void {
    if (prevState.type === "responding") {
      events.push({ type: "input_changed", active: true, text: body.inputText });
    } else {
      if (
        prevState.inputText == null ||
        prevState.inputState === "permission" ||
        prevState.inputState === "plan_review" ||
        body.inputText !== prevState.inputText
      ) {
        events.push({ type: "input_changed", active: true, text: body.inputText });
      }
    }
  }

  /** Emit indicator_changed when the indicator state differs from the last emission. */
  private emitIndicatorChange(active: boolean, spinner: string | null, events: SceneEvent[]): void {
    const text = (active && spinner) || "";
    if (text !== this.lastIndicator) {
      events.push({ type: "indicator_changed", active, text });
      this.lastIndicator = text;
    }
  }
}

export default (_config: SceneConfig) => new ClaudeCodeScene();
