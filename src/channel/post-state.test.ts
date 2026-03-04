import { describe, expect, test } from "bun:test";
import type { SceneEvent } from "../scene/interface.ts";
import {
  applySceneEvent,
  emptyPostState,
  type MessageFormatter,
  type PendingOp,
  type PostState,
  pushOp,
} from "./post-state.ts";

/** Trivial message type for testing. */
type Msg = { text: string };

function msg(text: string): Msg {
  return { text };
}

/** Minimal formatter that wraps content into Msg. */
const fmt: MessageFormatter<Msg> = {
  formatMessageContent(content, _echo) {
    const text = content.map((l) => (typeof l === "string" ? l : "")).join("\n");
    if (!text) return null;
    return msg(text);
  },
  formatQuestion(event) {
    return msg(`Q: ${event.question}`);
  },
  formatPermissionRequired(event) {
    return msg(`P: ${event.command}`);
  },
  appendContext(message, text) {
    return msg(`${message.text} [${text}]`);
  },
};

describe("pushOp", () => {
  test("appends post operations", () => {
    const ops: PendingOp<Msg>[] = [];
    const result = pushOp(ops, { type: "post", message: msg("a") });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "post" });
  });

  test("coalesces consecutive update operations", () => {
    let ops: PendingOp<Msg>[] = [];
    ops = pushOp(ops, { type: "update", message: msg("v1") });
    ops = pushOp(ops, { type: "update", message: msg("v2") });
    ops = pushOp(ops, { type: "update", message: msg("v3") });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "update", message: msg("v3") });
  });

  test("does not coalesce update after non-update", () => {
    let ops: PendingOp<Msg>[] = [];
    ops = pushOp(ops, { type: "post", message: msg("a") });
    ops = pushOp(ops, { type: "update", message: msg("u1") });
    ops = pushOp(ops, { type: "post", message: msg("b") });
    ops = pushOp(ops, { type: "update", message: msg("u2") });
    expect(ops).toHaveLength(4);
  });

  test("delete removes trailing updates", () => {
    let ops: PendingOp<Msg>[] = [];
    ops = pushOp(ops, { type: "post", message: msg("a") });
    ops = pushOp(ops, { type: "update", message: msg("u1") });
    ops = pushOp(ops, { type: "update", message: msg("u2") });
    ops = pushOp(ops, { type: "delete" });
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ type: "post" });
    expect(ops[1]).toMatchObject({ type: "delete" });
  });

  test("delete does not remove non-update ops", () => {
    let ops: PendingOp<Msg>[] = [];
    ops = pushOp(ops, { type: "post", message: msg("a") });
    ops = pushOp(ops, { type: "delete" });
    expect(ops).toHaveLength(2);
  });

  test("does not mutate input array", () => {
    const ops: PendingOp<Msg>[] = [{ type: "update", message: msg("v1") }];
    const result = pushOp(ops, { type: "update", message: msg("v2") });
    expect(ops).toHaveLength(1);
    expect((ops[0] as { message: Msg }).message.text).toBe("v1");
    expect(result).toHaveLength(1);
    expect((result[0] as { message: Msg }).message.text).toBe("v2");
  });
});

describe("applySceneEvent", () => {
  const empty = emptyPostState<Msg>();

  test("message_created enqueues a post", () => {
    const state = applySceneEvent(empty, messageCreated("hello"), false, fmt);
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "post" });
    expect(state.lastPost).toMatchObject({ type: "message", indicator: null });
  });

  test("message_created skips events that format to null", () => {
    const state = applySceneEvent(empty, { type: "message_created", content: [""] }, false, fmt);
    expect(state.pendingOps).toHaveLength(0);
    expect(state.lastPost).toBeNull();
  });

  test("message_created skips echo events when echo is false", () => {
    const state = applySceneEvent(
      empty,
      { type: "message_created", content: ["echoed"], echo: true },
      false,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("message_created includes echo events when echo is true", () => {
    const state = applySceneEvent(
      empty,
      { type: "message_created", content: ["echoed"], echo: true },
      true,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(1);
  });

  test("message_created carries forward active indicator", () => {
    let state: PostState<Msg> = {
      lastPost: { type: "message", base: msg("first"), indicator: "Thinking..." },
      pendingOps: [],
    };
    state = applySceneEvent(state, messageCreated("second"), false, fmt);

    expect(state.pendingOps).toHaveLength(2);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.pendingOps[1]).toMatchObject({ type: "post" });
    // The new post should include the indicator via appendContext
    const postOp = state.pendingOps[1] as { type: "post"; message: Msg };
    expect(postOp.message.text).toContain("Thinking...");
    expect(state.lastPost).toMatchObject({ type: "message", indicator: "Thinking..." });
  });

  test("last_message_updated enqueues an update", () => {
    const initial: PostState<Msg> = {
      lastPost: { type: "message", base: msg("first"), indicator: null },
      pendingOps: [],
    };
    const state = applySceneEvent(
      initial,
      { type: "last_message_updated", content: ["updated"] },
      false,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
  });

  test("last_message_updated with null content enqueues delete", () => {
    const initial: PostState<Msg> = {
      lastPost: { type: "message", base: msg("first"), indicator: null },
      pendingOps: [],
    };
    const state = applySceneEvent(
      initial,
      { type: "last_message_updated", content: null },
      false,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "delete" });
    expect(state.lastPost).toBeNull();
  });

  test("last_message_updated without prior message is ignored", () => {
    const state = applySceneEvent(
      empty,
      { type: "last_message_updated", content: ["orphan"] },
      false,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("indicator_changed active enqueues an update", () => {
    const initial: PostState<Msg> = {
      lastPost: { type: "message", base: msg("hello"), indicator: null },
      pendingOps: [],
    };
    const state = applySceneEvent(
      initial,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
    expect(state.lastPost).toMatchObject({ indicator: "Thinking..." });
  });

  test("indicator_changed inactive restores base", () => {
    const initial: PostState<Msg> = {
      lastPost: { type: "message", base: msg("hello"), indicator: "Thinking..." },
      pendingOps: [],
    };
    const state = applySceneEvent(
      initial,
      { type: "indicator_changed", active: false, text: "" },
      false,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.lastPost).toMatchObject({ indicator: null });
    const updateOp = state.pendingOps[0] as { type: "update"; message: Msg };
    expect(updateOp.message.text).toBe("hello");
  });

  test("indicator_changed without prior message is ignored", () => {
    const state = applySceneEvent(
      empty,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(0);
  });

  test("question_created enqueues a post", () => {
    const state = applySceneEvent(
      empty,
      {
        type: "question_created",
        question: "Continue?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
      false,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "post" });
    expect(state.lastPost).toEqual({ type: "question", optionCount: 2 });
  });

  test("permission_required enqueues a post", () => {
    const state = applySceneEvent(
      empty,
      {
        type: "permission_required",
        command: "rm -rf /",
        options: [{ label: "Allow" }],
      },
      false,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "post" });
    expect(state.lastPost).toEqual({ type: "permission", optionCount: 1 });
  });

  test("scene_state_changed is not handled", () => {
    const state = applySceneEvent(
      empty,
      { type: "scene_state_changed", state: "idle", idle: true },
      false,
      fmt,
    );
    expect(state).toBe(empty);
  });

  test("input_changed is explicitly skipped", () => {
    const state = applySceneEvent(
      empty,
      { type: "input_changed", active: true, text: "hello" },
      false,
      fmt,
    );
    expect(state).toBe(empty);
  });

  test("consecutive indicator changes coalesce via pushOp", () => {
    const initial: PostState<Msg> = {
      lastPost: { type: "message", base: msg("hello"), indicator: null },
      pendingOps: [],
    };
    let state = applySceneEvent(
      initial,
      { type: "indicator_changed", active: true, text: "Thinking..." },
      false,
      fmt,
    );
    state = applySceneEvent(
      state,
      { type: "indicator_changed", active: true, text: "Still thinking..." },
      false,
      fmt,
    );
    state = applySceneEvent(
      state,
      { type: "indicator_changed", active: false, text: "" },
      false,
      fmt,
    );
    expect(state.pendingOps).toHaveLength(1);
    expect(state.pendingOps[0]).toMatchObject({ type: "update" });
  });
});

function messageCreated(text: string): SceneEvent {
  return { type: "message_created", content: [text] };
}
