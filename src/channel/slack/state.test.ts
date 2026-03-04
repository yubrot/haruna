import { describe, expect, test } from "bun:test";
import type { SceneEvent } from "../../scene/interface.ts";
import {
  applySceneEvent,
  emptyPostState,
  type MessageFormatter,
  type PostState,
} from "../post-state.ts";
import {
  appendContext,
  formatMessageContent,
  formatPermissionRequired,
  formatQuestion,
  type SlackMessage,
} from "./formatting.ts";

const slackFormatter: MessageFormatter<SlackMessage> = {
  formatMessageContent,
  formatQuestion,
  formatPermissionRequired,
  appendContext,
};

/** Apply a scene event with the Slack formatter bound. */
function applySlackEvent(
  state: PostState<SlackMessage>,
  event: SceneEvent,
  echo: boolean,
): PostState<SlackMessage> {
  return applySceneEvent(state, event, echo, slackFormatter);
}

const initialState: PostState<SlackMessage> = emptyPostState<SlackMessage>();

function msg(text: string) {
  return {
    blocks: [
      {
        type: "rich_text" as const,
        elements: [
          {
            type: "rich_text_section" as const,
            elements: [{ type: "text" as const, text }],
          },
        ],
      },
    ],
    text,
  };
}

describe("applySlackEvent", () => {
  test("message_created enqueues a post", () => {
    const state = applySlackEvent(initialState, messageCreated("hello"), false);
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "post" });
    expect(state.lastPost).toMatchObject({ type: "message", indicator: null });
  });

  test("message_created skips events that format to null", () => {
    const state = applySlackEvent(initialState, { type: "message_created", content: [""] }, false);
    expect(state.pendingOps).toHaveLength(0);
    expect(state.lastPost).toBeNull();
  });

  test("message_created skips echo events when echo is false", () => {
    const state = applySlackEvent(
      initialState,
      {
        type: "message_created",
        content: ["echoed"],
        echo: true,
      },
      false,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("message_created includes echo events when echo is true", () => {
    const state = applySlackEvent(
      initialState,
      {
        type: "message_created",
        content: ["echoed"],
        echo: true,
      },
      true,
    );
    expect(state.pendingOps).toHaveLength(1);
  });

  test("message_created carries forward active indicator", () => {
    // Set up a state with an active indicator
    let state: PostState<SlackMessage> = {
      lastPost: {
        type: "message",
        base: [msg("first")],
        indicator: "Thinking...",
      },
      pendingOps: [],
    };
    state = applySlackEvent(state, messageCreated("second"), false);

    // Should strip indicator from previous message (update) + post new with indicator
    expect(state.pendingOps).toHaveLength(2);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.pendingOps[1]).toMatchObject({ type: "post" });
    // The new post should include the indicator
    const postOp = state.pendingOps[1] as {
      type: "post";
      messages: { blocks: unknown[] }[];
    };
    expect(postOp.messages[0]?.blocks).toHaveLength(2); // rich_text + context
    // lastPost should carry the indicator
    expect(state.lastPost).toMatchObject({
      type: "message",
      indicator: "Thinking...",
    });
  });

  test("last_message_updated enqueues an update", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: { type: "message", base: [msg("first")], indicator: null },
      pendingOps: [],
    };
    const state = applySlackEvent(
      initial,
      { type: "last_message_updated", content: ["updated"] },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.lastPost).toMatchObject({ type: "message" });
  });

  test("last_message_updated with null content enqueues delete", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: { type: "message", base: [msg("first")], indicator: null },
      pendingOps: [],
    };
    const state = applySlackEvent(initial, { type: "last_message_updated", content: null }, false);
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "delete" });
    expect(state.lastPost).toBeNull();
  });

  test("last_message_updated without prior message is ignored", () => {
    const state = applySlackEvent(
      initialState,
      { type: "last_message_updated", content: ["orphan"] },
      false,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("last_message_updated preserves active indicator", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: {
        type: "message",
        base: [msg("first")],
        indicator: "Working...",
      },
      pendingOps: [],
    };
    const state = applySlackEvent(
      initial,
      { type: "last_message_updated", content: ["updated"] },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    // The update message should include the indicator
    const updateOp = state.pendingOps[0] as {
      type: "update";
      messages: { blocks: unknown[] }[];
    };
    expect(updateOp.messages[0]?.blocks).toHaveLength(2); // rich_text + context
  });

  test("indicator_changed active enqueues an update", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: { type: "message", base: [msg("hello")], indicator: null },
      pendingOps: [],
    };
    const state = applySlackEvent(
      initial,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.lastPost).toMatchObject({ indicator: "Thinking..." });
  });

  test("indicator_changed inactive enqueues an update restoring base", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: {
        type: "message",
        base: [msg("hello")],
        indicator: "Thinking...",
      },
      pendingOps: [],
    };
    const state = applySlackEvent(
      initial,
      { type: "indicator_changed", active: false, text: "" },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.lastPost).toMatchObject({ indicator: null });
    // The update message should be the base (no context block)
    const updateOp = state.pendingOps[0] as {
      type: "update";
      messages: { blocks: unknown[] }[];
    };
    expect(updateOp.messages[0]?.blocks).toHaveLength(1); // only rich_text
  });

  test("indicator_changed without prior message is ignored", () => {
    const state = applySlackEvent(
      initialState,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("indicator_changed after question is ignored", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: { type: "question", optionCount: 2 },
      pendingOps: [],
    };
    const state = applySlackEvent(
      initial,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("question_created enqueues a post and sets lastPost to question", () => {
    const state = applySlackEvent(
      initialState,
      {
        type: "question_created",
        question: "Continue?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "post" });
    expect(state.lastPost).toEqual({ type: "question", optionCount: 2 });
  });

  test("question_created strips indicator from previous message", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: { type: "message", base: [msg("msg")], indicator: "Working..." },
      pendingOps: [],
    };
    const state = applySlackEvent(
      initial,
      {
        type: "question_created",
        question: "Pick",
        options: [{ label: "A" }],
      },
      false,
    );
    // update (strip indicator) + post (question)
    expect(state.pendingOps).toHaveLength(2);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.pendingOps[1]).toMatchObject({ type: "post" });
    expect(state.lastPost).toEqual({ type: "question", optionCount: 1 });
  });

  test("last_question_updated enqueues an update", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: { type: "question", optionCount: 2 },
      pendingOps: [],
    };
    const state = applySlackEvent(
      initial,
      {
        type: "last_question_updated",
        question: "Pick",
        options: [{ label: "A" }],
        selected: 0,
      },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
  });

  test("last_question_updated without prior question is ignored", () => {
    const state = applySlackEvent(
      initialState,
      {
        type: "last_question_updated",
        question: "orphan",
        options: [],
      },
      false,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("scene_state_changed is not handled (state unchanged)", () => {
    const state = applySlackEvent(
      initialState,
      { type: "scene_state_changed", state: "idle", idle: true },
      false,
    );
    expect(state).toBe(initialState);
  });

  test("input_changed is explicitly skipped", () => {
    const state = applySlackEvent(
      initialState,
      { type: "input_changed", active: true, text: "hello" },
      false,
    );
    expect(state).toBe(initialState);
  });

  test("permission_required enqueues a post and resets lastPost", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: { type: "message", base: [msg("msg")], indicator: null },
      pendingOps: [],
    };
    const state = applySlackEvent(
      initial,
      {
        type: "permission_required",
        command: "rm -rf /",
        description: "Dangerous",
        options: [{ label: "Allow" }],
      },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "post" });
    expect(state.lastPost).toEqual({ type: "permission", optionCount: 1 });
  });

  test("permission_required strips indicator from previous message", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: {
        type: "message",
        base: [msg("msg")],
        indicator: "Working...",
      },
      pendingOps: [],
    };
    const state = applySlackEvent(
      initial,
      {
        type: "permission_required",
        command: "rm -rf /",
        description: "Dangerous",
        options: [{ label: "Allow" }],
      },
      false,
    );
    // update (strip indicator) + post (permission)
    expect(state.pendingOps).toHaveLength(2);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.pendingOps[1]).toMatchObject({ type: "post" });
    expect(state.lastPost).toEqual({ type: "permission", optionCount: 1 });
  });

  test("consecutive indicator changes coalesce via pushOp", () => {
    const initial: PostState<SlackMessage> = {
      lastPost: { type: "message", base: [msg("hello")], indicator: null },
      pendingOps: [],
    };
    let state = applySlackEvent(
      initial,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
    );
    state = applySlackEvent(
      state,
      { type: "indicator_changed", active: true, text: "Still thinking..." },
      false,
    );
    state = applySlackEvent(state, { type: "indicator_changed", active: false, text: "" }, false);
    // All three consecutive updates should coalesce to one
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
  });
});

function messageCreated(text: string): SceneEvent {
  return { type: "message_created", content: [text] };
}
