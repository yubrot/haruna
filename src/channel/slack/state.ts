/**
 * Pure state management for Slack channel output.
 *
 * Defines the {@link PostState} type and transition functions that handle
 * scene events and operation coalescing without side effects.
 *
 * @module
 */

import type { SceneEvent } from "../../scene/interface.ts";
import {
  appendContext,
  formatMessageContent,
  formatPermissionRequired,
  formatQuestion,
  type SlackMessage,
} from "./formatting.ts";

/**
 * Tracks the logical state of the most recent post and pending API operations.
 *
 * This is a pure data structure — transitions are performed by
 * {@link applySceneEvent} and never trigger side effects.
 */
export interface PostState {
  /** Logical state of the most recent post (for indicator/update tracking). */
  lastPost:
    | { type: "message"; base: SlackMessage; indicator: string | null }
    | { type: "question" }
    | null;
  /** Pending API operations (coalesced on push). */
  pendingOps: PendingOp[];
}

/** An API operation waiting to be executed. */
export type PendingOp =
  | { type: "post"; message: SlackMessage }
  | { type: "update"; message: SlackMessage }
  | { type: "delete" };

/** Initial state with no active post and no pending operations. */
export const emptyPostState: PostState = { lastPost: null, pendingOps: [] };

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
 * @returns New post state after applying the event
 */
export function applySceneEvent(
  state: PostState,
  event: SceneEvent,
  echo: boolean,
): PostState {
  if (!echo && "echo" in event && event.echo) return state;

  switch (event.type) {
    case "message_created":
      return applyMessageCreated(state, event);
    case "last_message_updated":
      return applyLastMessageUpdated(state, event);
    case "indicator_changed":
      return applyIndicatorChanged(state, event);
    case "question_created":
      return applyQuestionCreated(state, event);
    case "last_question_updated":
      return applyLastQuestionUpdated(state, event);
    case "permission_required":
      return applyPermissionRequired(state, event);
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
export function pushOp(ops: readonly PendingOp[], op: PendingOp): PendingOp[] {
  switch (op.type) {
    case "update": {
      const tail = ops[ops.length - 1];
      if (tail?.type === "update") {
        // Coalesce: replace the trailing update
        return [...ops.slice(0, -1), op];
      }
      return [...ops, op];
    }
    case "delete": {
      // Remove trailing updates — they target a message about to be deleted
      let end = ops.length;
      while (end > 0 && ops[end - 1]?.type === "update") end--;
      return [...ops.slice(0, end), op];
    }
    default:
      return [...ops, op];
  }
}

function applyMessageCreated(
  state: PostState,
  event: SceneEvent & { type: "message_created" },
): PostState {
  const message = formatMessageContent(event.style, event.content);
  if (!message) return state;

  // Strip indicator from the previous message
  let ops = state.pendingOps;
  if (state.lastPost?.type === "message" && state.lastPost.indicator) {
    ops = pushOp(ops, {
      type: "update",
      message: state.lastPost.base,
    });
  }

  // Carry forward the active indicator
  const indicator =
    state.lastPost?.type === "message" ? state.lastPost.indicator : null;
  const lastPost = { type: "message" as const, base: message, indicator };
  const postMessage = indicator ? appendContext(message, indicator) : message;
  ops = pushOp(ops, { type: "post", message: postMessage });

  return { lastPost, pendingOps: ops };
}

function applyLastMessageUpdated(
  state: PostState,
  event: SceneEvent & { type: "last_message_updated" },
): PostState {
  if (event.content === null) {
    // Delete the last message
    if (state.lastPost?.type !== "message") return state;
    return {
      lastPost: null,
      pendingOps: pushOp(state.pendingOps, { type: "delete" }),
    };
  }

  const message = formatMessageContent(event.style, event.content);
  if (!message) return state;
  if (state.lastPost?.type !== "message") return state;

  const lastPost = { ...state.lastPost, base: message };
  const updateMessage = lastPost.indicator
    ? appendContext(message, lastPost.indicator)
    : message;
  return {
    lastPost,
    pendingOps: pushOp(state.pendingOps, {
      type: "update",
      message: updateMessage,
    }),
  };
}

function applyIndicatorChanged(
  state: PostState,
  event: SceneEvent & { type: "indicator_changed" },
): PostState {
  if (state.lastPost?.type !== "message") return state;

  const indicator = event.active ? event.text : null;
  const lastPost = { ...state.lastPost, indicator };
  const updateMessage = indicator
    ? appendContext(state.lastPost.base, indicator)
    : state.lastPost.base;
  return {
    lastPost,
    pendingOps: pushOp(state.pendingOps, {
      type: "update",
      message: updateMessage,
    }),
  };
}

function applyQuestionCreated(
  state: PostState,
  event: SceneEvent & { type: "question_created" },
): PostState {
  const message = formatQuestion(event);

  // Strip indicator from the previous message
  let ops = state.pendingOps;
  if (state.lastPost?.type === "message" && state.lastPost.indicator) {
    ops = pushOp(ops, { type: "update", message: state.lastPost.base });
  }

  ops = pushOp(ops, { type: "post", message });
  return { lastPost: { type: "question" }, pendingOps: ops };
}

function applyLastQuestionUpdated(
  state: PostState,
  event: SceneEvent & { type: "last_question_updated" },
): PostState {
  const message = formatQuestion(event);
  if (state.lastPost?.type !== "question") return state;

  return {
    lastPost: state.lastPost,
    pendingOps: pushOp(state.pendingOps, { type: "update", message }),
  };
}

function applyPermissionRequired(
  state: PostState,
  event: SceneEvent & { type: "permission_required" },
): PostState {
  const message = formatPermissionRequired(event);

  // Strip indicator from the previous message
  let ops = state.pendingOps;
  if (state.lastPost?.type === "message" && state.lastPost.indicator) {
    ops = pushOp(ops, { type: "update", message: state.lastPost.base });
  }

  ops = pushOp(ops, { type: "post", message });
  return { lastPost: null, pendingOps: ops };
}
