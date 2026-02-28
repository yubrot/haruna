import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  block,
  simplifyTraceContent,
  type TraceEntry,
  text,
  textContaining,
  textMatching,
  traceScene,
} from "../__testing.ts";
import shellScene from "./shell.ts";

const FIXTURES_DIR = resolve(import.meta.dir, "../../../fixtures/shell");

const inputOff = { type: "input_changed", active: false, text: "" } as const;

/** Trace a shell scene with the given config against a dump file. */
async function traceShell(
  dumpPath: string,
  sceneConfig: Record<string, unknown> = {},
): Promise<TraceEntry[]> {
  return simplifyTraceContent(
    await traceScene(
      shellScene({ _mode: "replay", _command: ["bash"], ...sceneConfig }),
      dumpPath,
    ),
  );
}

describe("Shell Scene", () => {
  test("prompt-ready: detect emits InputChanged active", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/prompt-ready.dump`);

    expect(trace).toMatchObject([
      { events: [{ type: "input_changed", active: true, text: "" }] },
    ]);
  });

  test("simple-command: echo produces prompt block and output block", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/simple-command.dump`);

    expect(trace).toMatchObject([
      { events: [{ type: "input_changed", active: true, text: "" }] },
      {
        events: [
          inputOff,
          block("$ echo hello"),
          text("hello"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("sequential-commands: three commands produce prompt + output pairs", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/sequential-commands.dump`);

    expect(trace).toMatchObject([
      { events: [{ type: "input_changed", active: true, text: "" }] },
      {
        events: [
          inputOff,
          block("$ echo first"),
          text("first"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
      {
        events: [
          inputOff,
          block("$ echo second"),
          text("second"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
      {
        events: [
          inputOff,
          block("$ echo third"),
          text("third"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("multiline-output: seq 1 20 produces prompt block and 20-line output block", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/multiline-output.dump`);

    expect(trace).toMatchObject([
      { events: [{ type: "input_changed", active: true, text: "" }] },
      {
        events: [
          inputOff,
          block("$ seq 1 20"),
          text(
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "10",
            "11",
            "12",
            "13",
            "14",
            "15",
            "16",
            "17",
            "18",
            "19",
            "20",
          ),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("empty-enter: prompt line emitted as output", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/empty-enter.dump`);

    expect(trace).toMatchObject([
      { events: [{ type: "input_changed", active: true, text: "" }] },
      {
        events: [
          inputOff,
          block("$"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("scrollback-flood: running transition and recovery with output", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/scrollback-flood.dump`);

    expect(trace).toMatchObject([
      // Snapshot 0: detect
      { events: [{ type: "input_changed", active: true, text: "" }] },
      // Snapshot 1: idle → running — output starts immediately
      {
        events: [inputOff, textContaining("50")],
      },
      // Snapshot 2: running → idle — remaining output + prompt
      {
        events: [
          textContaining("100"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("multiline-input: heredoc triggers running then output on EOF", async () => {
    // NOTE: With boundary at end-of-lines, the live ">" cursor line is
    // included in committed output. The heredoc continuation lines and the
    // final cat output appear as separate message_created events.
    const trace = await traceShell(`${FIXTURES_DIR}/multiline-input.dump`);

    expect(trace).toMatchObject([
      // Snapshot 0: detect
      { events: [{ type: "input_changed", active: true, text: "" }] },
      // Snapshot 1: idle → running — prompt block + continuation lines including ">"
      {
        events: [
          inputOff,
          block("$ cat << 'EOF'"),
          text("> line one", "> line two", "> line three", ">"),
        ],
      },
      // Snapshot 2: running → idle — final output + prompt
      {
        events: [
          text("line one", "line two", "line three"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("less: fullscreen pager preserves state, output captured on return", async () => {
    // less (alternate screen) followed by echo in a single command.
    // The scene preserves idle state during alternate screen. On return,
    // the prompt has moved, triggering idle→running→idle which captures
    // the command block and chained echo output.
    const trace = await traceShell(`${FIXTURES_DIR}/less.dump`);

    expect(trace).toMatchObject([
      // Snapshot 0: detect — prompt visible
      {
        state: "shell(idle)",
        firm: true,
        events: [{ type: "input_changed", active: true, text: "" }],
      },
      // Snapshot 1-3: alternate screen — state preserved,
      // pager content is intentionally ignored
      { state: "shell(idle)", firm: false, events: [] },
      { state: "shell(idle)", firm: false, events: [] },
      { state: "shell(idle)", firm: false, events: [] },
      // Snapshot 4: less quit, normal screen restored — prompt moved,
      // idle→running→idle captures command block + chained echo output
      {
        state: "shell(idle)",
        firm: true,
        events: [
          inputOff,
          block("$ seq 1 100 | less && echo after-pager"),
          text("after-pager"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("cat-blank-lines: blank lines within output are preserved", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/cat-blank-lines.dump`);

    expect(trace).toMatchObject([
      { events: [{ type: "input_changed", active: true, text: "" }] },
      {
        events: [
          inputOff,
          { type: "message_created", style: "block" },
          text("first", "", "third", "", "", "sixth"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("cat-large: large output followed by prompt recovery", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/cat-large.dump`);

    expect(trace).toMatchObject([
      { events: [{ type: "input_changed", active: true, text: "" }] },
      {
        events: [
          inputOff,
          { type: "message_created", style: "block" },
          textMatching(/Line 200/),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("custom-prompt: [haruna]$ prompt detected with custom prompt config", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/custom-prompt.dump`, {
      prompt: "^\\[haruna\\]\\$",
    });

    expect(trace).toMatchObject([
      { events: [{ type: "input_changed", active: true, text: "" }] },
      {
        events: [
          inputOff,
          block("[haruna]$ echo hello"),
          text("hello"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("custom-prompt: default prompt does not match [haruna]$ prompt", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/custom-prompt.dump`);

    // Default prompt "^\$" does not match "[haruna]$ "
    for (const entry of trace) {
      expect(entry.events).toEqual([]);
    }
  });

  test("multiline-prompt: precmd [haruna] prefix with promptPrefix config", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/multiline-prompt.dump`, {
      promptPrefix: "^\\[haruna\\]$",
    });

    expect(trace).toMatchObject([
      { events: [{ type: "input_changed", active: true, text: "" }] },
      {
        events: [
          inputOff,
          block("[haruna]", "$ echo hello"),
          text("hello"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
      {
        events: [
          inputOff,
          block("[haruna]", "$ echo world"),
          text("world"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("multiline-prompt: without promptPrefix, prefix line leaks into output", async () => {
    // Without promptPrefix, the scene doesn't know about the prefix line
    // so "[haruna]" appears as part of the command output
    const trace = await traceShell(`${FIXTURES_DIR}/multiline-prompt.dump`);

    expect(trace).toMatchObject([
      { events: [{ type: "input_changed", active: true, text: "" }] },
      {
        events: [
          inputOff,
          block("$ echo hello"),
          text("hello", "[haruna]"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
      {
        events: [
          inputOff,
          block("$ echo world"),
          text("world", "[haruna]"),
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("repeated-command: second command output captured via running state", async () => {
    const trace = await traceShell(`${FIXTURES_DIR}/repeated-command.dump`);

    expect(trace).toMatchObject([
      // Snapshot 0: detect — prompt visible
      { events: [{ type: "input_changed", active: true, text: "" }] },
      // Snapshot 1: idle → idle (virtual running) — first command output
      {
        events: [
          inputOff,
          { style: "text" },
          { type: "input_changed", active: true, text: "" },
        ],
      },
      // Snapshot 2: idle → running — second command starts, output begins immediately
      {
        events: [
          inputOff,
          block("$ for i in $(seq 1 50); do echo A$i; sleep 0.02; done"),
          textContaining("A1"),
        ],
      },
      // Snapshot 3: running → idle — remaining output
      {
        events: [
          { style: "text" },
          { type: "input_changed", active: true, text: "" },
        ],
      },
    ]);
  });

  test("progress-overwrite: in-place \\r overwrites are captured as snapshots of visible content", async () => {
    // NOTE: With boundary at end-of-lines, the cursor line is always
    // included. In-place \r overwrites appear as the value at each
    // snapshot; intermediate values between snapshots are not captured.
    const trace = await traceShell(`${FIXTURES_DIR}/progress-overwrite.dump`);

    expect(trace).toMatchObject([
      // Snapshot 0: detect
      { events: [{ type: "input_changed", active: true, text: "" }] },
      // Snapshot 1: idle → running — prompt block + progress at snapshot time
      {
        events: [inputOff, { style: "block" }, text("progress: 2/5")],
      },
      // Snapshot 2: running — no new lines (in-place overwrite, same line range)
      { events: [] },
      // Snapshot 3: running → idle — prompt returns
      {
        events: [{ type: "input_changed", active: true, text: "" }],
      },
    ]);
  });

  describe("configuration", () => {
    test("custom prompt overrides default", async () => {
      // Pattern that does NOT match "$ " — should not detect anything
      const trace = await traceShell(`${FIXTURES_DIR}/prompt-ready.dump`, {
        prompt: "^>>> ",
      });

      for (const entry of trace) {
        expect(entry.events).toEqual([]);
      }
    });

    test("promptPrefix rejects prompt when line above does not match", async () => {
      // Prompt marker matches but prefix requires a line that won't be there
      const trace = await traceShell(`${FIXTURES_DIR}/prompt-ready.dump`, {
        promptPrefix: "^user@host",
      });

      for (const entry of trace) {
        expect(entry.events).toEqual([]);
      }
    });

    test("priority is 100", () => {
      const scene = shellScene({ _mode: "replay", _command: ["bash"] });
      expect(scene.priority).toBe(100);
    });

    test("state reflects current shell state", async () => {
      const trace = await traceShell(`${FIXTURES_DIR}/scrollback-flood.dump`);

      expect(trace).toMatchObject([
        { state: "shell(idle)" },
        { state: "shell(running)" },
        { state: "shell(idle)" },
      ]);
    });

    test("continuation is firm when prompt is at screen bottom", async () => {
      const trace = await traceShell(`${FIXTURES_DIR}/simple-command.dump`);

      expect(trace).toMatchObject([{ firm: true }, { firm: true }]);
    });

    test("tab-completion: firm even with completion candidates below prompt", async () => {
      const trace = await traceShell(`${FIXTURES_DIR}/tab-completion.dump`);

      // Snapshot 0: initial prompt
      // Snapshot 1: Tab — candidates displayed below prompt
      // Snapshot 2: Tab — first candidate selected, candidates still below
      // Snapshot 3: Enter — command executed, prompt returns
      expect(trace).toMatchObject([
        {
          firm: true,
          state: "shell(idle)",
          events: [{ type: "input_changed", active: true, text: "" }],
        },
        {
          firm: true,
          state: "shell(idle)",
          events: [
            {
              type: "input_changed",
              active: true,
              text: "cat fixtures/shell/files/completion/foo",
            },
          ],
        },
        {
          firm: true,
          state: "shell(idle)",
          events: [
            {
              type: "input_changed",
              active: true,
              text: "cat fixtures/shell/files/completion/foo1.txt",
            },
          ],
        },
        {
          firm: true,
          state: "shell(idle)",
          events: [
            inputOff,
            block("$ cat fixtures/shell/files/completion/foo1.txt"),
            { type: "input_changed", active: true, text: "" },
          ],
        },
      ]);
    });
  });
});
