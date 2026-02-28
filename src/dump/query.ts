/**
 * High-level query interface for binary dump files.
 *
 * Pure data layer with no display logic.
 *
 * @module
 */

import { CompositeScene } from "../scene/builtin/composite.ts";
import type { Scene, SceneEvent } from "../scene/interface.ts";
import { collapseDiffContext, computeLineDiff } from "../util/diff.ts";
import { resolveTimestamp, type Timestamp } from "../util/time.ts";
import {
  type CursorState,
  type RichText,
  richTextToPlainText,
} from "../vt/snapshot.ts";
import { DumpReader, type SnapshotEntry } from "./reader.ts";

/** Unified query parameters for dump inspection. */
export interface DumpQuery {
  file: string;
  stats: boolean;
  list: boolean;
  /** Diff level: 0 = first-last, 1 = sequential deduped, 2 = all. `null` means no diff. */
  diff: 0 | 1 | 2 | null;
  at?: Timestamp;
  /** Scenes to use for analysis. `null` disables scene enrichment entirely. */
  scenes: Scene[] | null;
  search?: string;
  from?: Timestamp;
  to?: Timestamp;
  count: number;
  /** Number of context lines around changes in diffs. `null` means show all lines. */
  context: number | null;
}

/** Unified result from a dump query. */
export interface DumpResult {
  stats?: DumpStats;
  list?: DumpListPage;
  diff?: DumpDiff;
  snapshot?: DumpSnapshot;
}

/** Metadata and statistics from a dump file. */
export interface DumpStats {
  command: string[];
  duration: {
    start: number;
    end: number;
    seconds: number;
  } | null;
  records: {
    keyframes: number;
    deltas: number;
    snapshots: number;
  };
}

/** Paginated list of snapshots. */
export interface DumpListPage {
  entries: ListEntry[];
  nextFrom: number | null;
}

/** A single entry in the snapshot list. */
export interface ListEntry {
  timestamp: number;
  /** End timestamp when this entry represents a dedup group. */
  endTimestamp?: number;
  changedLines?: number;
  cursorMoved?: boolean;
  totalLines?: number;
  matches?: { row: number; text: string }[];
  state?: string;
  events?: string[];
}

/** Ordered list of diff entries. */
export type DumpDiff = DiffEntry[];

/** A single diff between two snapshots. */
export interface DiffEntry {
  from: number;
  to: number;
  changes: string;
}

/** Detail of a single snapshot at a given timestamp. */
export interface DumpSnapshot {
  timestamp: number;
  cols: number;
  rows: number;
  cursor: CursorState;
  lines: string[];
  /** Scene state description, present when a scene matched. */
  state?: string;
}

/**
 * Unified entry point for dump queries.
 *
 * Opens the dump file once and dispatches to internal helpers based on
 * the requested query sections.
 *
 * When both `list` and `diff` are requested, they share a single
 * snapshot iteration loop with a shared count budget.
 *
 * Exception: `diff === 0` + explicit `to` + no `list` bypasses the
 * loop entirely and scans the full `[from, to]` range without count limit.
 */
export async function queryDump(query: DumpQuery): Promise<DumpResult> {
  const reader = await DumpReader.open(query.file);
  const result: DumpResult = {};

  // Resolve string timestamps against the dump's start time
  const base = reader.stats.duration?.start ?? 0;
  const at =
    query.at !== undefined ? resolveTimestamp(query.at, base) : undefined;
  const from =
    query.from !== undefined ? resolveTimestamp(query.from, base) : undefined;
  const to =
    query.to !== undefined ? resolveTimestamp(query.to, base) : undefined;

  if (query.stats) result.stats = extractStats(reader);

  const needsList = query.list;
  const needsDiff = query.diff !== null;
  if (needsList || needsDiff) {
    // Exception: diff=0 + explicit to + no list → ad-hoc first-last diff
    if (query.diff === 0 && to !== undefined && !needsList) {
      result.diff = firstLastDiff(reader, from, to, query.context);
    } else {
      if (needsList) result.list = { entries: [], nextFrom: null };
      if (needsDiff) result.diff = [];
      collectListAndDiff(
        reader,
        {
          from,
          to,
          count: query.count,
          search: query.search,
          scenes: query.scenes,
          diff: query.diff,
          context: query.context,
        },
        result,
      );
    }
  }

  if (at !== undefined) {
    const snapshot = extractSnapshot(reader, at, {
      scenes: query.scenes,
    });
    if (snapshot) result.snapshot = snapshot;
  }

  return result;
}

/** Extract metadata and statistics from a reader. */
function extractStats(reader: DumpReader): DumpStats {
  return {
    command: reader.header.command,
    duration: reader.stats.duration
      ? {
          start: reader.stats.duration.start,
          end: reader.stats.duration.end,
          seconds:
            (reader.stats.duration.end - reader.stats.duration.start) / 1000,
        }
      : null,
    records: {
      keyframes: reader.stats.keyframes,
      deltas: reader.stats.deltas,
      snapshots: reader.stats.keyframes + reader.stats.deltas,
    },
  };
}

/** Extract a single snapshot from a reader, or `null` if none found. */
function extractSnapshot(
  reader: DumpReader,
  timestamp: number,
  options: { scenes: Scene[] | null },
): DumpSnapshot | null {
  const entry = reader.snapshotNearestTo(timestamp);
  if (!entry) return null;

  const result: DumpSnapshot = {
    timestamp: entry.snapshot.timestamp,
    cols: entry.snapshot.cols,
    rows: entry.snapshot.rows,
    cursor: entry.snapshot.cursor,
    lines: entry.snapshot.lines.map(richTextToPlainText),
  };

  if (options.scenes !== null) {
    const scene = new CompositeScene(options.scenes);
    scene.process(entry.snapshot);
    if (scene.state !== null) {
      result.state = scene.state;
    }
  }

  return result;
}

/**
 * Ad-hoc first-last diff without count limit.
 *
 * Scans all snapshots in `[from, to]` and produces a single diff
 * between the first and last.
 */
function firstLastDiff(
  reader: DumpReader,
  from: number | undefined,
  to: number,
  context: number | null,
): DumpDiff {
  let firstLines: string[] | null = null;
  let firstTs = 0;
  let lastLines: RichText[] | null = null;
  let lastTs = 0;

  for (const { snapshot } of reader.snapshots(from)) {
    if (snapshot.timestamp > to) break;
    if (!firstLines) {
      firstLines = snapshot.lines.map(richTextToPlainText);
      firstTs = snapshot.timestamp;
    }
    lastLines = snapshot.lines;
    lastTs = snapshot.timestamp;
  }

  if (!firstLines || !lastLines) return [];
  const lastPlain = lastLines.map(richTextToPlainText);
  const entries: DiffEntry[] = [];
  createDiffEntryPusher(entries, context)(
    firstLines,
    lastPlain,
    firstTs,
    lastTs,
  );
  return entries;
}

/**
 * Collect list entries and/or diff entries into `result`.
 *
 * Which sections to populate is determined by the pre-initialized fields
 * on `result`: if `result.list` exists, list entries are collected;
 * if `result.diff` exists, diff entries are collected.
 *
 * Shares a single snapshot iteration and count budget between both.
 */
function collectListAndDiff(
  reader: DumpReader,
  query: {
    from?: number;
    to?: number;
    count: number;
    search?: string;
    scenes: Scene[] | null;
    diff: 0 | 1 | 2 | null;
    context: number | null;
  },
  result: DumpResult,
): void {
  let regex: RegExp | undefined;
  if (query.search !== undefined) {
    try {
      regex = new RegExp(query.search);
    } catch (e) {
      throw new Error(
        `Invalid regex pattern: ${e instanceof SyntaxError ? e.message : query.search}`,
      );
    }
  }

  const scene = query.scenes !== null ? new CompositeScene(query.scenes) : null;

  let prevDeduplicationKey = "";

  const listPush =
    result.list !== undefined
      ? createListEntryPusher(result.list.entries, query.scenes !== null)
      : null;

  const diff =
    result.diff !== undefined && query.diff !== null
      ? createDiffCollector(query.diff, query.context)
      : null;

  let consumed = 0;

  for (const { snapshot, delta } of reader.snapshots(query.from)) {
    if (query.to !== undefined && snapshot.timestamp > query.to) break;

    const plainLines = snapshot.lines.map(richTextToPlainText);

    // Scene analysis (stateful — must run for every snapshot)
    let sceneState: string | null = null;
    let sceneEvents: SceneEvent[] = [];
    if (scene) {
      sceneEvents = scene.process(snapshot).events;
      sceneState = scene.state;
    }

    // Pattern filter
    let matchLines: { row: number; text: string }[] | undefined;
    if (regex) {
      const matches: { row: number; text: string }[] = [];
      for (let row = 0; row < plainLines.length; row++) {
        const line = plainLines[row] as string;
        if (regex.test(line)) {
          matches.push({ row, text: line });
        }
      }
      if (matches.length === 0) continue;
      matchLines = matches;
    }

    consumed++;
    if (consumed > query.count) {
      if (result.list) result.list.nextFrom = snapshot.timestamp;
      break;
    }

    const currentKey = buildDeduplicationKey(delta, sceneState);
    const isSameGroup =
      currentKey !== "" && currentKey === prevDeduplicationKey;

    listPush?.(
      { snapshot, delta, plainLines, matchLines, sceneState, sceneEvents },
      isSameGroup,
    );
    diff?.push(plainLines, snapshot.timestamp, isSameGroup);

    prevDeduplicationKey = currentKey;
  }

  if (diff) result.diff = diff.complete();
}

/** Create a closure that appends or extends list entries with dedup grouping. */
function createListEntryPusher(
  entries: ListEntry[],
  includeScenes: boolean,
): (
  entry: SnapshotEntry & {
    plainLines: string[];
    matchLines?: { row: number; text: string }[];
    sceneState: string | null;
    sceneEvents: SceneEvent[];
  },
  isSameGroup: boolean,
) => void {
  return (
    { snapshot, delta, plainLines, matchLines, sceneState, sceneEvents },
    isSameGroup,
  ) => {
    if (isSameGroup) {
      const last = entries[entries.length - 1] as ListEntry;
      last.endTimestamp = snapshot.timestamp;
      if (!matchLines) {
        last.totalLines = plainLines.length;
        if (delta) {
          last.changedLines = delta.changedLines.length;
          last.cursorMoved = delta.cursorMoved;
        }
      }
      return;
    }

    const listEntry: ListEntry = { timestamp: snapshot.timestamp };

    if (matchLines) {
      listEntry.matches = matchLines;
    } else {
      listEntry.totalLines = plainLines.length;
      if (delta) {
        listEntry.changedLines = delta.changedLines.length;
        listEntry.cursorMoved = delta.cursorMoved;
      }
    }

    if (includeScenes) {
      listEntry.state = sceneState ?? undefined;
      const eventTypes = sceneEvents.map((e) => e.type);
      if (eventTypes.length > 0) listEntry.events = eventTypes;
    }

    entries.push(listEntry);
  };
}

interface DiffCollector {
  /** Feed a snapshot's plain lines into the collector. */
  push(lines: string[], timestamp: number, isSameGroup: boolean): void;
  /** Finalize and return all collected diff entries. */
  complete(): DumpDiff;
}

function createDiffCollector(
  level: 0 | 1 | 2,
  context: number | null,
): DiffCollector {
  switch (level) {
    case 0:
      return createFirstLastCollector(context);
    case 1:
      return createSequentialDedupedCollector(context);
    case 2:
      return createSequentialAllCollector(context);
  }
}

/** Level 0: record first and last snapshot, produce a single first-last diff. */
function createFirstLastCollector(context: number | null): DiffCollector {
  const entries: DiffEntry[] = [];
  const push = createDiffEntryPusher(entries, context);
  let firstLines: string[] | null = null;
  let firstTimestamp = 0;
  let lastLines: string[] | null = null;
  let lastTimestamp = 0;

  return {
    push(lines, timestamp) {
      if (!firstLines) {
        firstLines = lines;
        firstTimestamp = timestamp;
      }
      lastLines = lines;
      lastTimestamp = timestamp;
    },
    complete() {
      if (firstLines && lastLines && firstTimestamp !== lastTimestamp) {
        push(firstLines, lastLines, firstTimestamp, lastTimestamp);
      }
      return entries;
    },
  };
}

/**
 * Level 1: emit cross-group diffs at group boundaries and within-group diffs
 * for groups that span multiple snapshots.
 */
function createSequentialDedupedCollector(
  context: number | null,
): DiffCollector {
  const entries: DiffEntry[] = [];
  const push = createDiffEntryPusher(entries, context);
  let prevLines: string[] | null = null;
  let prevTimestamp = 0;
  let groupStartLines: string[] | null = null;
  let groupStartTimestamp = 0;

  function flushWithinGroup(): void {
    if (
      groupStartLines !== null &&
      prevLines !== null &&
      groupStartTimestamp !== prevTimestamp
    ) {
      push(groupStartLines, prevLines, groupStartTimestamp, prevTimestamp);
    }
  }

  return {
    push(lines, timestamp, isSameGroup) {
      if (!isSameGroup) {
        flushWithinGroup();
        // Emit cross-group diff
        if (prevLines !== null) {
          push(prevLines, lines, prevTimestamp, timestamp);
        }
        groupStartLines = lines;
        groupStartTimestamp = timestamp;
      }
      prevLines = lines;
      prevTimestamp = timestamp;
    },
    complete() {
      flushWithinGroup();
      return entries;
    },
  };
}

/** Level 2: emit a diff for every consecutive pair of snapshots. */
function createSequentialAllCollector(context: number | null): DiffCollector {
  const entries: DiffEntry[] = [];
  const push = createDiffEntryPusher(entries, context);
  let prevLines: string[] | null = null;
  let prevTimestamp = 0;

  return {
    push(lines, timestamp) {
      if (prevLines !== null) {
        push(prevLines, lines, prevTimestamp, timestamp);
      }
      prevLines = lines;
      prevTimestamp = timestamp;
    },
    complete() {
      return entries;
    },
  };
}

/** Create a closure that computes a line diff and pushes a non-empty entry. */
function createDiffEntryPusher(
  entries: DiffEntry[],
  context: number | null,
): (fromLines: string[], toLines: string[], from: number, to: number) => void {
  return (fromLines, toLines, from, to) => {
    const changes = computeLineDiff(fromLines, toLines);
    if (changes.length === 0) return;
    const collapsedChanges = collapseDiffContext(changes, context);
    entries.push({ from, to, changes: collapsedChanges });
  };
}

/**
 * Build a deduplication key from delta changed-line indices and scene state.
 *
 * Returns an empty string when delta is `null` (first snapshot),
 * which forces a new group to start.
 */
function buildDeduplicationKey(
  delta: {
    changedLines: number[];
    scrolledLines: number;
    cursorMoved: boolean;
  } | null,
  sceneState: string | null,
): string {
  if (!delta) return "";

  // Classify into disjoint groups:
  //   "C" = cursor move only (no line changes)
  //   "L:<indices>" = lines changed
  const changeKey =
    delta.changedLines.length > 0
      ? `L:${delta.changedLines.toSorted((a, b) => a - b).join(",")}`
      : "C";

  const parts: string[] = [changeKey];
  if (sceneState !== null) {
    parts.push(sceneState);
  }
  return parts.join("|");
}
