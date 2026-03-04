/**
 * Platform-agnostic post state management and operation coalescing.
 *
 * Defines the generic {@link PostState} type, {@link MessageFormatter} interface,
 * and pure transition functions shared by all messaging-platform channels
 * (Slack, Discord, etc.).
 *
 * @module
 */

import type { SceneEvent } from "../scene/interface.ts";
import type { RichText } from "../vt/snapshot.ts";

/**
 * Tracks the logical state of the most recent post and pending API operations.
 *
 * This is a pure data structure — transitions are performed by
 * {@link applySceneEvent} and never trigger side effects.
 *
 * @typeParam M - Platform-specific message type (e.g. SlackMessage, string)
 */
export interface PostState<M> {
  /** Logical state of the most recent post (for indicator/update tracking). */
  lastPost:
    | { type: "message"; base: M; indicator: string | null }
    | { type: "question"; optionCount: number }
    | { type: "permission"; optionCount: number }
    | null;
  /** Pending API operations (coalesced on push). */
  pendingOps: PendingOp<M>[];
}

/** An API operation waiting to be executed. */
export type PendingOp<M> =
  | { type: "post"; message: M }
  | { type: "update"; message: M }
  | { type: "delete" };

/**
 * Create an initial state with no active post and no pending operations.
 *
 * @returns Empty post state
 */
export function emptyPostState<M>(): PostState<M> {
  return { lastPost: null, pendingOps: [] };
}

/**
 * Platform-specific message formatting contract.
 *
 * Channels implement this interface to convert scene events into
 * their native message format (e.g. Slack Block Kit, Discord Markdown).
 *
 * @typeParam M - Platform-specific message type
 */
export interface MessageFormatter<M> {
  /**
   * Format message content into a platform message.
   *
   * The formatter derives the visual style from the content:
   * - `echo` or multi-line content (`content.length > 1`) → block (code block / preformatted)
   * - Single-line content → text (styled text)
   *
   * @param content - Rich text lines to render
   * @param echo - Whether this message is an echo of user input
   * @returns Platform message, or `null` when content is empty
   */
  formatMessageContent(content: RichText[], echo: boolean): M | null;

  /**
   * Format a question event into a platform message.
   *
   * @param event - Question payload
   * @returns Platform message with question body and option list
   */
  formatQuestion(event: {
    question: string;
    options: { label: string; description?: string }[];
  }): M;

  /**
   * Format a permission-required event into a platform message.
   *
   * @param event - Permission-required payload
   * @returns Platform message with warning and options
   */
  formatPermissionRequired(event: {
    command: string;
    description?: string;
    options: { label: string; description?: string }[];
  }): M;

  /**
   * Return a copy of `message` with a context indicator appended.
   *
   * @param message - Base message
   * @param text - Context text (e.g. indicator status)
   * @returns New message with context added
   */
  appendContext(message: M, text: string): M;
}

/**
 * Apply a scene event to the post state, producing a new state.
 *
 * All event types are handled explicitly. `scene_state_changed` is not
 * handled here — it depends on input-side state and must be managed by
 * the caller.
 *
 * @param state - Current post state
 * @param event - Scene event to apply
 * @param echo - Whether echo events should be forwarded
 * @param fmt - Platform-specific message formatter
 * @returns New post state after applying the event
 */
export function applySceneEvent<M>(
  state: PostState<M>,
  event: SceneEvent,
  echo: boolean,
  fmt: MessageFormatter<M>,
): PostState<M> {
  if (!echo && "echo" in event && event.echo) return state;

  switch (event.type) {
    case "message_created":
      return applyMessageCreated(state, event, fmt);
    case "last_message_updated":
      return applyLastMessageUpdated(state, event, fmt);
    case "indicator_changed":
      return applyIndicatorChanged(state, event, fmt);
    case "question_created":
      return applyQuestionCreated(state, event, fmt);
    case "last_question_updated":
      return applyLastQuestionUpdated(state, event, fmt);
    case "permission_required":
      return applyPermissionRequired(state, event, fmt);
    case "scene_state_changed":
      return state;
    case "input_changed":
      return state;
    default:
      return event satisfies never;
  }
}

/**
 * Append an operation to the pending ops list with coalescing rules.
 *
 * - Consecutive `update` operations are coalesced (only the latest is kept).
 * - A `delete` removes any trailing `update` operations before being appended.
 * - Other operations are appended as-is.
 *
 * @param ops - Current pending operations
 * @param op - Operation to append
 * @returns New ops array with the operation applied
 */
export function pushOp<M>(ops: readonly PendingOp<M>[], op: PendingOp<M>): PendingOp<M>[] {
  switch (op.type) {
    case "update": {
      const tail = ops[ops.length - 1];
      if (tail?.type === "update") {
        return [...ops.slice(0, -1), op];
      }
      return [...ops, op];
    }
    case "delete": {
      let end = ops.length;
      while (end > 0 && ops[end - 1]?.type === "update") end--;
      return [...ops.slice(0, end), op];
    }
    default:
      return [...ops, op];
  }
}

function applyMessageCreated<M>(
  state: PostState<M>,
  event: SceneEvent & { type: "message_created" },
  fmt: MessageFormatter<M>,
): PostState<M> {
  const message = fmt.formatMessageContent(event.content, event.echo === true);
  if (!message) return state;

  let ops = state.pendingOps;
  if (state.lastPost?.type === "message" && state.lastPost.indicator) {
    ops = pushOp(ops, { type: "update", message: state.lastPost.base });
  }

  const indicator = state.lastPost?.type === "message" ? state.lastPost.indicator : null;
  const lastPost = { type: "message" as const, base: message, indicator };
  const postMessage = indicator ? fmt.appendContext(message, indicator) : message;
  ops = pushOp(ops, { type: "post", message: postMessage });

  return { lastPost, pendingOps: ops };
}

function applyLastMessageUpdated<M>(
  state: PostState<M>,
  event: SceneEvent & { type: "last_message_updated" },
  fmt: MessageFormatter<M>,
): PostState<M> {
  if (event.content === null) {
    if (state.lastPost?.type !== "message") return state;
    return {
      lastPost: null,
      pendingOps: pushOp(state.pendingOps, { type: "delete" }),
    };
  }

  const message = fmt.formatMessageContent(event.content, event.echo === true);
  if (!message) return state;
  if (state.lastPost?.type !== "message") return state;

  const lastPost = { ...state.lastPost, base: message };
  const updateMessage = lastPost.indicator
    ? fmt.appendContext(message, lastPost.indicator)
    : message;
  return {
    lastPost,
    pendingOps: pushOp(state.pendingOps, { type: "update", message: updateMessage }),
  };
}

function applyIndicatorChanged<M>(
  state: PostState<M>,
  event: SceneEvent & { type: "indicator_changed" },
  fmt: MessageFormatter<M>,
): PostState<M> {
  if (state.lastPost?.type !== "message") return state;

  const indicator = event.active ? event.text : null;
  const lastPost = { ...state.lastPost, indicator };
  const updateMessage = indicator
    ? fmt.appendContext(state.lastPost.base, indicator)
    : state.lastPost.base;
  return {
    lastPost,
    pendingOps: pushOp(state.pendingOps, { type: "update", message: updateMessage }),
  };
}

function applyQuestionCreated<M>(
  state: PostState<M>,
  event: SceneEvent & { type: "question_created" },
  fmt: MessageFormatter<M>,
): PostState<M> {
  const message = fmt.formatQuestion(event);

  let ops = state.pendingOps;
  if (state.lastPost?.type === "message" && state.lastPost.indicator) {
    ops = pushOp(ops, { type: "update", message: state.lastPost.base });
  }

  ops = pushOp(ops, { type: "post", message });
  return { lastPost: { type: "question", optionCount: event.options.length }, pendingOps: ops };
}

function applyLastQuestionUpdated<M>(
  state: PostState<M>,
  event: SceneEvent & { type: "last_question_updated" },
  fmt: MessageFormatter<M>,
): PostState<M> {
  const message = fmt.formatQuestion(event);
  if (state.lastPost?.type !== "question") return state;

  return {
    lastPost: { type: "question", optionCount: event.options.length },
    pendingOps: pushOp(state.pendingOps, { type: "update", message }),
  };
}

function applyPermissionRequired<M>(
  state: PostState<M>,
  event: SceneEvent & { type: "permission_required" },
  fmt: MessageFormatter<M>,
): PostState<M> {
  const message = fmt.formatPermissionRequired(event);

  let ops = state.pendingOps;
  if (state.lastPost?.type === "message" && state.lastPost.indicator) {
    ops = pushOp(ops, { type: "update", message: state.lastPost.base });
  }

  ops = pushOp(ops, { type: "post", message });
  return {
    lastPost: { type: "permission", optionCount: event.options.length },
    pendingOps: ops,
  };
}
