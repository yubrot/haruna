/**
 * CLI dump command — query resolution, execution, and display formatting.
 *
 * @module
 */

import type { Config } from "../config.ts";
import type { DumpQuery, DumpResult } from "../dump/query.ts";
import { queryDump } from "../dump/query.ts";
import type { Scene, SceneEvent } from "../scene/interface.ts";
import { loadScenes } from "../scene/loader.ts";
import { formatDate, formatTime } from "../util/time.ts";
import { richTextToPlainText } from "../vt/snapshot.ts";

/** Parsed dump CLI options with all defaults resolved. */
export interface DumpArgs {
  file: string;
  stats: boolean;
  list: boolean;
  /** Diff level: 0 = first-last, 1 = sequential deduped, 2 = all. `null` means no diff. */
  diff: 0 | 1 | 2 | null;
  at?: string;
  /** Scene analysis level: `"type"` for event type names, `"verbose"` for full content. */
  scene: "type" | "verbose" | false;
  search?: string;
  from?: string;
  to?: string;
  count: number;
  /** Number of context lines around changes in diffs. `null` means show all lines. */
  context: number | null;
  json: boolean;
}

/**
 * Execute a dump query and display results.
 *
 * Loads scenes when `scene` is set, builds a {@link DumpQuery}, and
 * delegates to {@link queryDump} for execution.
 *
 * @param args - Parsed dump arguments with all defaults resolved
 * @param config - Resolved configuration
 * @returns Exit code (0 on success, 1 on error)
 */
export async function runDump(args: DumpArgs, config: Config): Promise<number> {
  try {
    const query = await buildQuery(args, config);

    if (args.json) {
      console.log(JSON.stringify(await queryDump(query)));
    } else {
      displayDumpResult(await queryDump(query), args);
    }

    return 0;
  } catch (e) {
    console.error(`[haruna] ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

/** Build a {@link DumpQuery} from resolved CLI arguments, loading scenes if requested. */
async function buildQuery(args: DumpArgs, config: Config): Promise<DumpQuery> {
  let scenes: Scene[] | null = null;
  if (args.scene) {
    const resolved = await config.resolveSceneEntries();
    scenes = await loadScenes(resolved, {
      _mode: "replay",
      _command: [],
    });
  }

  return {
    file: args.file,
    stats: args.stats,
    list: args.list,
    diff: args.diff,
    at: args.at,
    scenes,
    search: args.search,
    from: args.from,
    to: args.to,
    count: args.count,
    context: args.context,
  };
}

/** Display a dump result in human-readable format. */
function displayDumpResult(result: DumpResult, args: DumpArgs): void {
  let needsSeparator = false;

  if (result.stats) {
    const info = result.stats;
    console.log(`Command:    ${info.command.join(" ")}`);
    if (info.duration) {
      console.log(
        `Duration:   ${formatDate(info.duration.start)} → ${formatTime(info.duration.end)} (${info.duration.seconds.toFixed(1)}s)`,
      );
    } else {
      console.log("Duration:   (no snapshots)");
    }
    console.log(
      `Snapshots:  ${info.records.snapshots} (keyframes: ${info.records.keyframes}, deltas: ${info.records.deltas})`,
    );
    needsSeparator = true;
  }

  if (result.list) {
    if (needsSeparator) console.log("");
    for (const entry of result.list.entries) {
      const tsLabel = entry.endTimestamp
        ? `${entry.timestamp}..${entry.endTimestamp}`
        : String(entry.timestamp);
      if (entry.matches) {
        // Pattern mode
        for (const m of entry.matches) {
          console.log(`${tsLabel}  row ${m.row}: ${m.text}`);
        }
      } else {
        // No-pattern mode
        const lineInfo =
          entry.changedLines !== undefined
            ? entry.changedLines > 0
              ? `${entry.changedLines} line${entry.changedLines === 1 ? "" : "s"} changed`
              : entry.cursorMoved
                ? "cursor moved"
                : "0 lines changed"
            : `${entry.totalLines} lines`;
        const parts = [tsLabel, lineInfo];
        if (args.scene) {
          parts.push(entry.state ?? "(no match)");
          if (entry.events && entry.events.length > 0)
            parts.push(`[${entry.events.map((e) => e.type).join(", ")}]`);
        }
        console.log(parts.join("  "));
        if (args.scene === "verbose" && entry.events) {
          for (const event of entry.events) {
            console.log(`  ${formatSceneEvent(event)}`);
          }
        }
      }
    }
    if (result.list.nextFrom !== null) {
      console.log(`--- next: --from ${result.list.nextFrom}`);
    }
    needsSeparator = true;
  }

  if (result.diff) {
    if (needsSeparator) console.log("");
    for (const diffEntry of result.diff) {
      console.log(`--- ${diffEntry.from}`);
      console.log(`+++ ${diffEntry.to}`);
      if (diffEntry.changes.length > 0) {
        console.log(diffEntry.changes);
      }
    }
    needsSeparator = true;
  }

  if (result.snapshot) {
    if (needsSeparator) console.log("");
    const show = result.snapshot;
    console.log(`Timestamp:  ${show.timestamp}`);
    console.log(`Size:       ${show.cols}x${show.rows}`);
    console.log(
      `Cursor:     (${show.cursor.x}, ${show.cursor.y}, ${show.cursor.visible ? "visible" : "hidden"})`,
    );
    if (show.state) {
      console.log(`State:      ${show.state}`);
    }
    console.log("");
    for (let i = 0; i < show.lines.length; i++) {
      console.log(`${String(i).padStart(3)}: ${show.lines[i]}`);
    }
  }
}

const MAX_LINE_LENGTH = 60;

/** Truncate a string, keeping both the beginning and end visible. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 3) / 2);
  return `${s.slice(0, half)}...${s.slice(-half)}`;
}

/**
 * Format a scene event for verbose display.
 *
 * @param event - The scene event to format
 * @returns A single-line human-readable summary
 */
function formatSceneEvent(event: SceneEvent): string {
  switch (event.type) {
    case "message_created":
    case "last_message_updated": {
      const flags: string[] = [];
      if (event.style !== "text") flags.push(event.style);
      if (event.echo) flags.push("echo");
      const content = event.content;
      if (content === null) {
        flags.push("null");
        return `${event.type}(${flags.join(", ")})`;
      }
      const lines = content.map(richTextToPlainText);
      const quoted = formatContentLines(lines);
      const parts = [...flags, ...quoted];
      return `${event.type}(${parts.join(", ")})`;
    }
    case "input_changed":
      return event.text
        ? `input_changed(active=${event.active}, ${JSON.stringify(truncate(event.text, MAX_LINE_LENGTH))})`
        : `input_changed(active=${event.active})`;
    case "indicator_changed":
      return event.text
        ? `indicator_changed(active=${event.active}, ${JSON.stringify(truncate(event.text, MAX_LINE_LENGTH))})`
        : `indicator_changed(active=${event.active})`;
    case "scene_state_changed":
      return `scene_state_changed(${JSON.stringify(event.state)})`;
    case "question_created":
      return `question_created(${JSON.stringify(truncate(event.question, MAX_LINE_LENGTH))})`;
    case "last_question_updated":
      return `last_question_updated(${JSON.stringify(truncate(event.question, MAX_LINE_LENGTH))})`;
    case "permission_required":
      return `permission_required(${JSON.stringify(truncate(event.command, MAX_LINE_LENGTH))})`;
  }
}

/** Format content lines for verbose display: first/last for 3+, all for 1-2. */
function formatContentLines(lines: string[]): string[] {
  if (lines.length === 0) return [];
  if (lines.length <= 2) {
    return lines.map((l) => JSON.stringify(truncate(l, MAX_LINE_LENGTH)));
  }
  return [
    JSON.stringify(truncate(lines[0] as string, MAX_LINE_LENGTH)),
    "...",
    JSON.stringify(truncate(lines[lines.length - 1] as string, MAX_LINE_LENGTH)),
  ];
}
