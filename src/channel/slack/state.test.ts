import { describe, expect, test } from "bun:test";
import type { SceneEvent } from "../../scene/interface.ts";
import {
  applySceneEvent,
  emptyPostState,
  type PendingOp,
  type PostState,
  pushOp,
} from "./state.ts";

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

describe("pushOp", () => {
  test("appends post operations", () => {
    const ops: PendingOp[] = [];
    const result = pushOp(ops, { type: "post", message: msg("a") });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "post" });
  });

  test("coalesces consecutive update operations", () => {
    let ops: PendingOp[] = [];
    ops = pushOp(ops, { type: "update", message: msg("v1") });
    ops = pushOp(ops, { type: "update", message: msg("v2") });
    ops = pushOp(ops, { type: "update", message: msg("v3") });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "update", message: msg("v3") });
  });

  test("does not coalesce update after non-update", () => {
    let ops: PendingOp[] = [];
    ops = pushOp(ops, { type: "post", message: msg("a") });
    ops = pushOp(ops, { type: "update", message: msg("u1") });
    ops = pushOp(ops, { type: "post", message: msg("b") });
    ops = pushOp(ops, { type: "update", message: msg("u2") });
    expect(ops).toHaveLength(4);
  });

  test("delete removes trailing updates", () => {
    let ops: PendingOp[] = [];
    ops = pushOp(ops, { type: "post", message: msg("a") });
    ops = pushOp(ops, { type: "update", message: msg("u1") });
    ops = pushOp(ops, { type: "update", message: msg("u2") });
    ops = pushOp(ops, { type: "delete" });
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ type: "post" });
    expect(ops[1]).toMatchObject({ type: "delete" });
  });

  test("delete does not remove non-update ops", () => {
    let ops: PendingOp[] = [];
    ops = pushOp(ops, { type: "post", message: msg("a") });
    ops = pushOp(ops, { type: "delete" });
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ type: "post" });
    expect(ops[1]).toMatchObject({ type: "delete" });
  });

  test("does not mutate input array", () => {
    const ops: PendingOp[] = [{ type: "update", message: msg("v1") }];
    const result = pushOp(ops, { type: "update", message: msg("v2") });
    expect(ops).toHaveLength(1);
    expect((ops[0] as { message: { text: string } }).message.text).toBe("v1");
    expect(result).toHaveLength(1);
    expect((result[0] as { message: { text: string } }).message.text).toBe("v2");
  });
});

describe("applySceneEvent", () => {
  test("message_created enqueues a post", () => {
    const state = applySceneEvent(emptyPostState, messageCreated("hello"), false);
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "post" });
    expect(state.lastPost).toMatchObject({ type: "message", indicator: null });
  });

  test("message_created skips events that format to null", () => {
    const state = applySceneEvent(
      emptyPostState,
      { type: "message_created", style: "text", content: [""] },
      false,
    );
    expect(state.pendingOps).toHaveLength(0);
    expect(state.lastPost).toBeNull();
  });

  test("message_created skips echo events when echo is false", () => {
    const state = applySceneEvent(
      emptyPostState,
      {
        type: "message_created",
        style: "text",
        content: ["echoed"],
        echo: true,
      },
      false,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("message_created includes echo events when echo is true", () => {
    const state = applySceneEvent(
      emptyPostState,
      {
        type: "message_created",
        style: "text",
        content: ["echoed"],
        echo: true,
      },
      true,
    );
    expect(state.pendingOps).toHaveLength(1);
  });

  test("message_created carries forward active indicator", () => {
    // Set up a state with an active indicator
    let state: PostState = {
      lastPost: {
        type: "message",
        base: msg("first"),
        indicator: "Thinking...",
      },
      pendingOps: [],
    };
    state = applySceneEvent(state, messageCreated("second"), false);

    // Should strip indicator from previous message (update) + post new with indicator
    expect(state.pendingOps).toHaveLength(2);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.pendingOps[1]).toMatchObject({ type: "post" });
    // The new post should include the indicator
    const postOp = state.pendingOps[1] as {
      type: "post";
      message: { blocks: unknown[] };
    };
    expect(postOp.message.blocks).toHaveLength(2); // rich_text + context
    // lastPost should carry the indicator
    expect(state.lastPost).toMatchObject({
      type: "message",
      indicator: "Thinking...",
    });
  });

  test("last_message_updated enqueues an update", () => {
    const initial: PostState = {
      lastPost: { type: "message", base: msg("first"), indicator: null },
      pendingOps: [],
    };
    const state = applySceneEvent(
      initial,
      { type: "last_message_updated", style: "text", content: ["updated"] },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.lastPost).toMatchObject({ type: "message" });
  });

  test("last_message_updated with null content enqueues delete", () => {
    const initial: PostState = {
      lastPost: { type: "message", base: msg("first"), indicator: null },
      pendingOps: [],
    };
    const state = applySceneEvent(
      initial,
      { type: "last_message_updated", style: "text", content: null },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "delete" });
    expect(state.lastPost).toBeNull();
  });

  test("last_message_updated without prior message is ignored", () => {
    const state = applySceneEvent(
      emptyPostState,
      { type: "last_message_updated", style: "text", content: ["orphan"] },
      false,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("last_message_updated preserves active indicator", () => {
    const initial: PostState = {
      lastPost: {
        type: "message",
        base: msg("first"),
        indicator: "Working...",
      },
      pendingOps: [],
    };
    const state = applySceneEvent(
      initial,
      { type: "last_message_updated", style: "text", content: ["updated"] },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    // The update message should include the indicator
    const updateOp = state.pendingOps[0] as {
      type: "update";
      message: { blocks: unknown[] };
    };
    expect(updateOp.message.blocks).toHaveLength(2); // rich_text + context
  });

  test("indicator_changed active enqueues an update", () => {
    const initial: PostState = {
      lastPost: { type: "message", base: msg("hello"), indicator: null },
      pendingOps: [],
    };
    const state = applySceneEvent(
      initial,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.lastPost).toMatchObject({ indicator: "Thinking..." });
  });

  test("indicator_changed inactive enqueues an update restoring base", () => {
    const initial: PostState = {
      lastPost: {
        type: "message",
        base: msg("hello"),
        indicator: "Thinking...",
      },
      pendingOps: [],
    };
    const state = applySceneEvent(
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
      message: { blocks: unknown[] };
    };
    expect(updateOp.message.blocks).toHaveLength(1); // only rich_text
  });

  test("indicator_changed without prior message is ignored", () => {
    const state = applySceneEvent(
      emptyPostState,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("indicator_changed after question is ignored", () => {
    const initial: PostState = {
      lastPost: { type: "question" },
      pendingOps: [],
    };
    const state = applySceneEvent(
      initial,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("question_created enqueues a post and sets lastPost to question", () => {
    const state = applySceneEvent(
      emptyPostState,
      {
        type: "question_created",
        question: "Continue?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
      false,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "post" });
    expect(state.lastPost).toEqual({ type: "question" });
  });

  test("question_created strips indicator from previous message", () => {
    const initial: PostState = {
      lastPost: { type: "message", base: msg("msg"), indicator: "Working..." },
      pendingOps: [],
    };
    const state = applySceneEvent(
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
    expect(state.lastPost).toEqual({ type: "question" });
  });

  test("last_question_updated enqueues an update", () => {
    const initial: PostState = {
      lastPost: { type: "question" },
      pendingOps: [],
    };
    const state = applySceneEvent(
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
    const state = applySceneEvent(
      emptyPostState,
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
    const state = applySceneEvent(
      emptyPostState,
      { type: "scene_state_changed", state: "idle", idle: true },
      false,
    );
    expect(state).toBe(emptyPostState);
  });

  test("input_changed is explicitly skipped", () => {
    const state = applySceneEvent(
      emptyPostState,
      { type: "input_changed", active: true, text: "hello" },
      false,
    );
    expect(state).toBe(emptyPostState);
  });

  test("permission_required enqueues a post and resets lastPost", () => {
    const initial: PostState = {
      lastPost: { type: "message", base: msg("msg"), indicator: null },
      pendingOps: [],
    };
    const state = applySceneEvent(
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
    expect(state.lastPost).toBeNull();
  });

  test("permission_required strips indicator from previous message", () => {
    const initial: PostState = {
      lastPost: {
        type: "message",
        base: msg("msg"),
        indicator: "Working...",
      },
      pendingOps: [],
    };
    const state = applySceneEvent(
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
    expect(state.lastPost).toBeNull();
  });

  test("consecutive indicator changes coalesce via pushOp", () => {
    const initial: PostState = {
      lastPost: { type: "message", base: msg("hello"), indicator: null },
      pendingOps: [],
    };
    let state = applySceneEvent(
      initial,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
    );
    state = applySceneEvent(
      state,
      { type: "indicator_changed", active: true, text: "Still thinking..." },
      false,
    );
    state = applySceneEvent(state, { type: "indicator_changed", active: false, text: "" }, false);
    // All three consecutive updates should coalesce to one
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
  });
});

function messageCreated(text: string): SceneEvent {
  return { type: "message_created", style: "text", content: [text] };
}
