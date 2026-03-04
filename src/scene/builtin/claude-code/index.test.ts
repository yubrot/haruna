import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DumpReader } from "../../../dump/reader.ts";
import { simplifyTraceContent, type TraceEntry, traceScene } from "../../__testing.ts";
import { CompositeScene } from "../composite.ts";
import claudeCodeScene from "./index.ts";

const FIXTURES_DIR = resolve(import.meta.dir, "../../../../fixtures/claude-code");

/** Trace a claude-code scene against a dump file. */
async function traceClaudeCode(dumpPath: string): Promise<TraceEntry[]> {
  return simplifyTraceContent(
    await traceScene(claudeCodeScene({ _mode: "replay", _command: ["claude"] }), dumpPath),
  );
}

describe("Claude Code Scene", () => {
  test("idle: detect emits input_changed active", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/idle.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        firm: true,
        events: [{ type: "input_changed", active: true }],
      },
    ]);
  });

  test("simple-response: idle → responding → idle with text message", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/simple-response.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      {
        state: "claude-code(free)",
        events: [
          { type: "message_created" },
          { type: "message_created" },
          { type: "input_changed", active: true },
        ],
      },
    ]);
  });

  test("tool-use: tool invocation produces block messages", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/tool-use.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      {
        state: "claude-code(free)",
        events: [
          { type: "message_created" },
          { type: "message_created" },
          { type: "message_created" },
          { type: "input_changed", active: true },
        ],
      },
    ]);
  });

  test("question: question UI detected with options and selection changes", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/question.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      {
        state: "claude-code(question)",
        events: [
          { type: "message_created" },
          {
            type: "question_created",
            question: expect.stringContaining("option"),
            options: expect.arrayContaining([
              expect.objectContaining({
                label: expect.stringContaining("Option A"),
              }),
            ]),
            selected: 0,
          },
          { type: "input_changed", active: true },
        ],
      },
      {
        state: "claude-code(question)",
        events: [{ type: "last_question_updated", selected: 1 }],
      },
      {
        state: "claude-code(free)",
        events: [
          { type: "last_message_updated" },
          { type: "message_created" },
          { type: "message_created" },
        ],
      },
    ]);
  });

  test("multi-question: tabbed questions, selection, review screen", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/multi-question.dump`);

    expect(trace).toMatchObject([
      // Snapshot 0: idle
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      // Snapshot 1: Color question (☐ Color  ☐ Size), selected=0
      {
        state: "claude-code(question)",
        events: [
          { type: "message_created", echo: true },
          {
            type: "question_created",
            question: expect.stringContaining("color"),
            selected: 0,
          },
          { type: "input_changed", active: true },
        ],
      },
      // Snapshot 2: Blue selected (same question, selection changed)
      {
        state: "claude-code(question)",
        events: [{ type: "last_question_updated", selected: 1 }],
      },
      // Snapshot 3: Size question (☒ Color  ☐ Size), selected=0
      {
        state: "claude-code(question)",
        events: [
          {
            type: "question_created",
            question: expect.stringContaining("size"),
            selected: 0,
          },
        ],
      },
      // Snapshot 4: review screen (☒ Color  ☒ Size  ✔ Submit)
      {
        state: "claude-code(question)",
        events: [
          {
            type: "question_created",
            question: expect.stringContaining("submit"),
            options: expect.arrayContaining([
              expect.objectContaining({ label: "Submit answers" }),
              expect.objectContaining({ label: "Cancel" }),
            ]),
            selected: 0,
          },
        ],
      },
      // Snapshot 5: idle after response
      {
        state: "claude-code(free)",
        events: [
          { type: "last_message_updated", echo: true },
          { type: "message_created" },
          { type: "message_created" },
        ],
      },
    ]);
  });

  test("multi-turn: two exchanges produce multiple messages", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/multi-turn.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      {
        state: "claude-code(free)",
        events: [
          { type: "message_created", echo: true },
          { type: "message_created" },
          { type: "input_changed", active: true },
        ],
      },
      {
        state: "claude-code(free)",
        events: [{ type: "message_created", echo: true }, { type: "message_created" }],
      },
    ]);
  });

  test("multiline-input: multi-line input detected correctly", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/multiline-input.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      {
        state: "claude-code(free)",
        firm: true,
        events: [{ type: "input_changed", active: true }],
      },
      {
        state: "claude-code(free)",
        events: [
          { type: "message_created", echo: true },
          { type: "message_created" },
          { type: "input_changed", active: true },
        ],
      },
    ]);
  });

  test("plan-mode: switch to plan mode, plan review, and return to idle", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/plan-mode.dump`);

    expect(trace).toMatchObject([
      // Snapshot 0: normal idle (⏵⏵)
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      // Snapshot 1: plan mode idle (⏸) — no event changes
      { state: "claude-code(free)", events: [] },
      // Snapshot 2: plan review UI — content messages + question + input inactive
      {
        state: "claude-code(plan_review)",
        events: expect.arrayContaining([
          expect.objectContaining({ type: "message_created" }),
          expect.objectContaining({
            type: "question_created",
            question: expect.stringContaining("Claude has written up a plan"),
            selected: 0,
          }),
          expect.objectContaining({ type: "input_changed", active: false }),
        ]),
      },
      // Snapshot 3: selection changed (option 4)
      {
        state: "claude-code(plan_review)",
        events: [{ type: "last_question_updated", selected: 3 }],
      },
      // Snapshot 4: plan review dismissed — back to free
      {
        state: "claude-code(free)",
        events: [
          { type: "last_message_updated" },
          { type: "message_created" },
          { type: "input_changed", active: true },
        ],
      },
      // Snapshot 5: no change (identical screen)
      { state: "claude-code(free)", events: [] },
      // Snapshot 6: follow-up exchange
      {
        state: "claude-code(free)",
        events: [{ type: "message_created", echo: true }, { type: "message_created" }],
      },
      // Snapshot 7: /clear — content reset, input reactivated
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      // Snapshot 8: new response after /clear
      {
        state: "claude-code(free)",
        events: [
          { type: "message_created", echo: true },
          { type: "message_created" },
          { type: "input_changed", active: true },
        ],
      },
    ]);
  });

  test("mode-cycle: all status line modes (⏵⏵, ⏸, ?) detected as free", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/mode-cycle.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        firm: true,
        events: [{ type: "input_changed", active: true }],
      },
      { state: "claude-code(free)", firm: true, events: [] },
      { state: "claude-code(free)", firm: true, events: [] },
      { state: "claude-code(free)", firm: true, events: [] },
    ]);
  });

  test("permission: prompt detected with command and options", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/permission.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      {
        state: "claude-code(permission)",
        events: [
          { type: "message_created" },
          { type: "message_created" },
          {
            type: "permission_required",
            command: expect.any(String),
            options: expect.arrayContaining([
              expect.objectContaining({ label: expect.any(String) }),
            ]),
          },
          { type: "input_changed", active: false },
        ],
      },
      {
        state: "claude-code(free)",
        events: [
          { type: "last_message_updated" },
          { type: "message_created" },
          { type: "input_changed", active: true },
        ],
      },
    ]);
  });

  test("fetch-permission: fetch permission prompt detected", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/fetch-permission.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      {
        state: "claude-code(permission)",
        events: [
          { type: "message_created" },
          { type: "message_created" },
          {
            type: "permission_required",
            command: "Fetch",
            options: expect.arrayContaining([expect.objectContaining({ label: "Yes" })]),
          },
          { type: "input_changed", active: false },
        ],
      },
      {
        state: "claude-code(free)",
        events: [
          { type: "last_message_updated" },
          { type: "message_created" },
          { type: "input_changed", active: true },
        ],
      },
    ]);
  });

  test("command: shell command execution via ! prompt", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/command.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      {
        state: "claude-code(free)",
        events: [
          { type: "message_created", echo: true },
          { type: "message_created" },
          { type: "message_created" },
          { type: "input_changed", active: true },
        ],
      },
    ]);
  });

  test("write-permission: file write permission prompt and rejection", async () => {
    const trace = await traceClaudeCode(`${FIXTURES_DIR}/write-permission.dump`);

    expect(trace).toMatchObject([
      {
        state: "claude-code(free)",
        events: [{ type: "input_changed", active: true }],
      },
      {
        state: "claude-code(permission)",
        events: [
          { type: "message_created", echo: true },
          { type: "message_created" },
          {
            type: "permission_required",
            command: "Create file",
            options: expect.arrayContaining([
              expect.objectContaining({ label: "Yes" }),
              expect.objectContaining({ label: "No" }),
            ]),
          },
          { type: "input_changed", active: false },
        ],
      },
      // Snapshot 2: selection changed (No selected) — no new events
      {
        state: "claude-code(permission)",
        events: [],
      },
      // Snapshot 3: back to idle after rejection
      {
        state: "claude-code(free)",
        events: [{ type: "last_message_updated" }, { type: "input_changed", active: true }],
      },
    ]);
  });

  test("priority is 50", () => {
    const scene = claudeCodeScene({ _mode: "replay", _command: ["claude"] });
    expect(scene.priority).toBe(50);
  });

  describe("send", () => {
    /**
     * Create a scene and feed snapshots from a dump file, stopping after
     * `snapshotCount` snapshots so the scene is left in a known state.
     */
    async function sceneAfterSnapshots(dumpPath: string, snapshotCount: number) {
      const scene = claudeCodeScene({
        _mode: "replay",
        _command: ["claude"],
      });
      const composite = new CompositeScene([scene]);
      const reader = await DumpReader.open(dumpPath);
      let i = 0;
      for (const { snapshot } of reader.snapshots()) {
        composite.process(snapshot);
        i++;
        if (i >= snapshotCount) break;
      }
      return scene;
    }

    test("returns null when scene is not active", () => {
      const scene = claudeCodeScene({
        _mode: "replay",
        _command: ["claude"],
      });
      expect(scene.encodeInput?.({ type: "text", content: "hello" })).toBeNull();
      expect(scene.encodeInput?.({ type: "select", index: 0 })).toBeNull();
    });

    test("text input in free state returns text + delay + CR", async () => {
      // idle.dump has 1 snapshot → state: free
      const scene = await sceneAfterSnapshots(`${FIXTURES_DIR}/idle.dump`, 1);
      expect(scene.encodeInput?.({ type: "text", content: "hello" })).toEqual([
        "hello",
        { sleep: 50 },
        "\r",
      ]);
    });

    test("select input in free state returns null", async () => {
      const scene = await sceneAfterSnapshots(`${FIXTURES_DIR}/idle.dump`, 1);
      expect(scene.encodeInput?.({ type: "select", index: 0 })).toBeNull();
    });

    test("text input in question state sends ESC + delay + text + CR", async () => {
      // question.dump: snapshot 2 enters question state
      const scene = await sceneAfterSnapshots(`${FIXTURES_DIR}/question.dump`, 2);
      expect(scene.state).toBe("claude-code(question)");
      expect(scene.encodeInput?.({ type: "text", content: "hello" })).toEqual([
        "\x1b",
        { sleep: 300 },
        "hello",
        { sleep: 50 },
        "\r",
      ]);
    });

    test("text input in permission state sends ESC + delay + text + CR", async () => {
      const scene = await sceneAfterSnapshots(`${FIXTURES_DIR}/permission.dump`, 2);
      expect(scene.state).toBe("claude-code(permission)");
      expect(scene.encodeInput?.({ type: "text", content: "hello" })).toEqual([
        "\x1b",
        { sleep: 300 },
        "hello",
        { sleep: 50 },
        "\r",
      ]);
    });

    test("select input in question state sends number key + delay", async () => {
      const scene = await sceneAfterSnapshots(`${FIXTURES_DIR}/question.dump`, 2);
      expect(scene.state).toBe("claude-code(question)");
      expect(scene.encodeInput?.({ type: "select", index: 0 })).toEqual(["1", { sleep: 50 }]);
      expect(scene.encodeInput?.({ type: "select", index: 2 })).toEqual(["3", { sleep: 50 }]);
    });

    test("select input in permission state sends number key + delay", async () => {
      const scene = await sceneAfterSnapshots(`${FIXTURES_DIR}/permission.dump`, 2);
      expect(scene.state).toBe("claude-code(permission)");
      expect(scene.encodeInput?.({ type: "select", index: 1 })).toEqual(["2", { sleep: 50 }]);
    });

    test("select input in plan_review state sends number key + delay", async () => {
      // plan-mode.dump: snapshot 3 enters plan_review state
      const scene = await sceneAfterSnapshots(`${FIXTURES_DIR}/plan-mode.dump`, 3);
      expect(scene.state).toBe("claude-code(plan_review)");
      expect(scene.encodeInput?.({ type: "select", index: 0 })).toEqual(["1", { sleep: 50 }]);
    });

    test("select input with out-of-bounds index returns null", async () => {
      const scene = await sceneAfterSnapshots(`${FIXTURES_DIR}/question.dump`, 2);
      expect(scene.state).toBe("claude-code(question)");
      expect(scene.encodeInput?.({ type: "select", index: 999 })).toBeNull();
    });
  });
});
