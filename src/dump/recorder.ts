/**
 * Record engine — run a procedure script to capture VT snapshots into a dump file.
 *
 * Pure logic layer with no CLI concerns (no console output).
 *
 * @module
 */

import * as v from "valibot";
import { runPty } from "../pty/index.ts";
import { VirtualTerminal } from "../vt/index.ts";
import { richTextToPlainText, snapshotsEqual } from "../vt/snapshot.ts";
import { DumpWriter } from "./writer.ts";

/** Schema for a wait condition in a procedure step. */
export const WaitConditionSchema = v.intersect([
  v.union([
    v.object({ content: v.string() }),
    v.object({ stable: v.pipe(v.number(), v.integer(), v.minValue(0)) }),
    v.object({ cursor: v.object({ visible: v.boolean() }) }),
  ]),
  v.object({
    timeout: v.optional(v.number(), 10000),
    poll: v.optional(v.number(), 50),
  }),
]);

/** Schema for a single procedure step. */
export const StepSchema = v.union([
  v.object({ input: v.string() }),
  v.object({ wait: WaitConditionSchema }),
  v.literal("snapshot"),
]);

/** Schema for a complete record procedure script. */
export const RecordScriptSchema = v.object({
  command: v.array(v.string()),
  env: v.optional(v.record(v.string(), v.string()), {}),
  cols: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 80),
  rows: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 24),
  scrollback: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 24),
  steps: v.array(StepSchema),
});

/** A parsed and validated record procedure script. */
export type RecordScript = v.InferOutput<typeof RecordScriptSchema>;

/** A single step in the procedure. */
export type Step = v.InferOutput<typeof StepSchema>;

/** A wait condition within a wait step. */
export type WaitCondition = v.InferOutput<typeof WaitConditionSchema>;

/**
 * Parse and validate a YAML procedure script.
 *
 * @param content - Raw YAML string
 * @returns A validated RecordScript
 * @throws When the YAML is invalid or does not match the schema
 */
export function parseRecordScript(content: string): RecordScript {
  return v.parse(RecordScriptSchema, Bun.YAML.parse(content));
}

/**
 * Run a record procedure script and write snapshots to a dump file.
 *
 * @param script - A validated record procedure script
 * @param outputPath - Path for the output dump file
 * @returns The number of snapshots recorded
 * @throws When a wait condition times out or another error occurs during recording
 */
export async function recordDump(
  script: RecordScript,
  outputPath: string,
): Promise<number> {
  const vt = new VirtualTerminal({
    cols: script.cols,
    rows: script.rows,
    scrollback: script.scrollback,
  });

  const writer = new DumpWriter(outputPath, { command: script.command });
  let snapshotIndex = 0;

  try {
    const session = runPty({
      command: script.command,
      env: script.env,
      cols: script.cols,
      rows: script.rows,
      passthrough: false,
      onData: (data) => vt.write(data),
    });

    try {
      for (const step of script.steps) {
        if (step === "snapshot") {
          await vt.flush();
          // Override timestamp with deterministic value
          writer.write({
            ...vt.takeSnapshot(),
            timestamp: 1000 * snapshotIndex,
          });
          snapshotIndex++;
        } else if ("input" in step) {
          session.write(step.input);
        } else if ("wait" in step) {
          await wait(step.wait, vt);
        }
      }
    } finally {
      // Terminate child if still running
      session.kill("SIGTERM");
      await session.exited;
    }
  } finally {
    await writer.end();
    vt.dispose();
  }

  return snapshotIndex;
}

/**
 * Execute a wait condition with polling.
 *
 * @param condition - The wait condition to satisfy
 * @param vt - The virtual terminal to poll
 * @throws When the timeout is exceeded
 */
async function wait(
  condition: WaitCondition,
  vt: VirtualTerminal,
): Promise<void> {
  const deadline = Date.now() + condition.timeout;

  if ("content" in condition) {
    const regex = new RegExp(condition.content);
    while (Date.now() < deadline) {
      await vt.flush();
      const snapshot = vt.takeSnapshot();
      for (const line of snapshot.lines) {
        const text = richTextToPlainText(line);
        if (regex.test(text)) return;
      }
      await Bun.sleep(condition.poll);
    }
    throw new Error(
      `Timed out waiting for content matching /${condition.content}/`,
    );
  }

  if ("stable" in condition) {
    await vt.flush();
    let lastSnapshot = vt.takeSnapshot();
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      await Bun.sleep(condition.poll);
      await vt.flush();
      const current = vt.takeSnapshot();
      if (!snapshotsEqual(lastSnapshot, current)) {
        lastSnapshot = current;
        stableSince = Date.now();
      }
      if (Date.now() - stableSince >= condition.stable) return;
    }
    throw new Error(`Timed out waiting for ${condition.stable}ms of stability`);
  }

  if ("cursor" in condition) {
    while (Date.now() < deadline) {
      await vt.flush();
      const snapshot = vt.takeSnapshot();
      if (snapshot.cursor.visible === condition.cursor.visible) return;
      await Bun.sleep(condition.poll);
    }
    throw new Error(
      `Timed out waiting for cursor visible=${condition.cursor.visible}`,
    );
  }

  throw new Error("Unknown wait condition");
}
