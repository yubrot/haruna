/**
 * Virtual terminal snapshot data types, comparison functions, and delta computation.
 *
 * @module
 */

/**
 * A point-in-time capture of the virtual terminal state.
 *
 * `lines` contains all non-trailing-blank lines (scrollback + active viewport
 * content). Trailing blank lines are stripped; use `rows` to recover the
 * original viewport height.
 */
export interface Snapshot {
  /** Terminal lines with trailing blanks stripped (oldest first). */
  lines: RichText[];
  /** Cursor position and visibility. */
  cursor: CursorState;
  /** Terminal width in columns. */
  cols: number;
  /** Terminal height in rows. */
  rows: number;
  /** Whether the terminal is currently in alternate screen mode. */
  alternate: boolean;
  /**
   * Absolute index of `lines[0]` in the virtual line buffer.
   *
   * Increments whenever lines are trimmed from the front (scrollback eviction).
   * Used to compute the shift between two consecutive snapshots:
   * `shift = curr.linesOffset - prev.linesOffset`.
   *
   * `null` when tracking is lost (e.g. marker disposed between distant
   * snapshots, or terminal resized). Consumers should treat `null` as
   * "cannot compute shift — full refresh required".
   */
  linesOffset: number | null;
  /** Timestamp of capture (Date.now()). */
  timestamp: number;
}

/** Cursor position and visibility state. */
export interface CursorState {
  /** Column position (0-based). */
  x: number;
  /** Row position, measured from the end of lines (0 = last line). */
  y: number;
  /** Whether the cursor is visible (DECTCEM). */
  visible: boolean;
}

/**
 * Check whether two snapshots are visually identical.
 *
 * Compares lines (text and style), cursor state, terminal dimensions,
 * linesOffset, and alternate screen mode. Only timestamp is ignored.
 *
 * @param a - First snapshot
 * @param b - Second snapshot
 * @returns `true` if the snapshots are visually identical
 */
export function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  return (
    a.cursor.x === b.cursor.x &&
    a.cursor.y === b.cursor.y &&
    a.cursor.visible === b.cursor.visible &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.alternate === b.alternate &&
    a.linesOffset === b.linesOffset &&
    richTextLinesEqual(a.lines, b.lines)
  );
}

/**
 * The difference between two snapshots (from previous to current).
 *
 * Each field is present only when the corresponding part of the snapshot
 * has changed relative to the previous snapshot.
 */
export interface SnapshotDelta {
  /** Number of lines shifted out from the beginning (scroll). */
  shift?: number;
  /**
   * Changed, new, or truncated lines as `[index, content]` pairs (post-shift indices).
   *
   * When `content` is `null`, the line at `index` (and all subsequent lines)
   * has been removed by trailing-blank stripping. Consumers should truncate
   * their line buffer to `index` when they encounter a `null` entry.
   */
  lines?: [index: number, content: RichText | null][];
  /** Cursor state if changed. */
  cursor?: CursorState;
  /** Terminal width if changed. */
  cols?: number;
  /** Terminal height if changed. */
  rows?: number;
  /** Whether the terminal switched to/from alternate screen mode. */
  alternate?: boolean;
}

/**
 * Compute the difference between two snapshots.
 *
 * Uses `linesOffset` to determine the shift (leading line eviction), then
 * per-index comparison for line patches. Returns `null` when a delta cannot
 * be computed: either `linesOffset` is `null` (tracking lost), or the shift
 * is negative (i.e. `curr.linesOffset < prev.linesOffset`).
 *
 * @param prev - The base snapshot
 * @param curr - The current snapshot to compare against the base
 * @returns A delta containing only the changed fields, or `null` when the
 *          change cannot be expressed as a delta (keyframe required)
 */
export function computeSnapshotDiff(
  prev: Snapshot,
  curr: Snapshot,
): SnapshotDelta | null {
  // Cannot compute delta when curr has lost offset tracking
  if (curr.linesOffset == null) return null;

  // prev.linesOffset null means "reset" — next offset starts from 0
  const shift = curr.linesOffset - (prev.linesOffset ?? 0);

  // Negative shift means curr starts before prev — cannot express as delta
  if (shift < 0) return null;

  const prevAfterShift = prev.lines.length - shift;

  const delta: SnapshotDelta = {};

  if (shift > 0) delta.shift = shift;

  // Per-index comparison after shift for line patches
  const changedLines: [number, RichText | null][] = [];
  // prevAfterShift may be negative when shift exceeds prev.lines.length;
  // clamp to 0 so the overlap loop is safely skipped.
  const overlapEnd = Math.max(0, Math.min(curr.lines.length, prevAfterShift));
  for (let i = 0; i < overlapEnd; i++) {
    if (
      !richTextEqual(
        prev.lines[shift + i] as RichText,
        curr.lines[i] as RichText,
      )
    ) {
      changedLines.push([i, curr.lines[i] as RichText]);
    }
  }
  // New lines appended beyond the previous range
  for (let i = Math.max(0, prevAfterShift); i < curr.lines.length; i++) {
    changedLines.push([i, curr.lines[i] as RichText]);
  }
  // Trailing lines removed (trailing-blank stripping) — a single null
  // entry suffices since applySnapshotDiff truncates at the first null.
  if (curr.lines.length < prevAfterShift) {
    changedLines.push([curr.lines.length, null]);
  }

  if (changedLines.length > 0) delta.lines = changedLines;

  // Cursor
  if (
    prev.cursor.x !== curr.cursor.x ||
    prev.cursor.y !== curr.cursor.y ||
    prev.cursor.visible !== curr.cursor.visible
  ) {
    delta.cursor = { ...curr.cursor };
  }

  // Dimensions
  if (prev.cols !== curr.cols) delta.cols = curr.cols;
  if (prev.rows !== curr.rows) delta.rows = curr.rows;

  // Alternate screen
  if (prev.alternate !== curr.alternate) delta.alternate = curr.alternate;

  return delta;
}

/**
 * Reconstruct a full snapshot by applying a delta to a base snapshot.
 *
 * Apply order: shift → line patches.
 *
 * @param base - The base snapshot (typically from the last keyframe or reconstructed snapshot)
 * @param delta - The delta to apply
 * @param timestamp - The timestamp for the resulting snapshot
 * @returns A new snapshot with the delta applied
 */
export function applySnapshotDiff(
  base: Snapshot,
  delta: SnapshotDelta,
  timestamp: number,
): Snapshot {
  // 1. Shift: remove leading `shift` lines
  const lines = delta.shift ? base.lines.slice(delta.shift) : [...base.lines];

  // 2. Line patches: replace existing, append new, or truncate
  if (delta.lines) {
    for (const [index, content] of delta.lines) {
      if (content === null) {
        // Trailing lines removed — truncate to this index
        lines.length = index;
        break;
      }
      // Extend with empty lines if needed
      while (lines.length <= index) {
        lines.push("");
      }
      lines[index] = content;
    }
  }

  return {
    lines,
    cursor: delta.cursor ? { ...delta.cursor } : { ...base.cursor },
    cols: delta.cols ?? base.cols,
    rows: delta.rows ?? base.rows,
    alternate: delta.alternate ?? base.alternate,
    linesOffset: (base.linesOffset ?? 0) + (delta.shift ?? 0),
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

/**
 * Rich text: a plain string (no styling) or an array of segments.
 *
 * A plain string shorthand avoids the `["text"]` wrapper overhead
 * for undecorated lines.
 */
export type RichText = string | RichSegment[];

/** A single segment: either a plain string or a styled segment. */
export type RichSegment = string | StyledSegment;

/**
 * A styled text segment with SGR attributes applied to a plain string.
 *
 * Property names are shortened for compact JSON serialization.
 * Attribute fields use `true` (not `boolean`) so they are omitted
 * when inactive.
 */
export interface StyledSegment {
  /** Text content. */
  t: string;
  /** Foreground color: palette index (0–255) or `"#rrggbb"`. */
  fg?: number | string;
  /** Background color: palette index (0–255) or `"#rrggbb"`. */
  bg?: number | string;
  /** Bold (SGR 1). */
  b?: true;
  /** Dim / faint (SGR 2). */
  d?: true;
  /** Italic (SGR 3). */
  i?: true;
  /** Underline (SGR 4). */
  u?: true;
  /** Strikethrough (SGR 9). */
  s?: true;
  /** Inverse / reverse video (SGR 7). */
  v?: true;
  /** Overline (SGR 53). */
  o?: true;
}

/**
 * Extract plain text from a {@link RichText} value, stripping attributes.
 *
 * @param rt - The rich text to convert
 * @returns The concatenated plain text
 */
export function richTextToPlainText(rt: RichText): string {
  if (typeof rt === "string") return rt;
  let result = "";
  for (const segment of rt) {
    if (typeof segment === "string") {
      result += segment;
    } else {
      result += segment.t;
    }
  }
  return result;
}

/**
 * Compare two {@link RichSegment} values for equality.
 *
 * @param a - First segment
 * @param b - Second segment
 * @returns `true` if the segments are structurally identical
 */
function richSegmentEqual(a: RichSegment, b: RichSegment): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return (
    a.t === b.t &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.b === b.b &&
    a.d === b.d &&
    a.i === b.i &&
    a.u === b.u &&
    a.s === b.s &&
    a.v === b.v &&
    a.o === b.o
  );
}

/**
 * Compare two {@link RichText} values for equality.
 *
 * Plain strings are compared directly; segment arrays are compared
 * element-wise without allocation.
 *
 * @param a - First rich text value
 * @param b - Second rich text value
 * @returns `true` if the values are structurally identical
 */
export function richTextEqual(a: RichText, b: RichText): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!richSegmentEqual(a[i] as RichSegment, b[i] as RichSegment))
      return false;
  }
  return true;
}

/**
 * Compare two {@link RichText} line arrays for equality.
 *
 * @param a - First line array
 * @param b - Second line array
 * @returns `true` if the arrays are structurally identical
 */
export function richTextLinesEqual(a: RichText[], b: RichText[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!richTextEqual(a[i] as RichText, b[i] as RichText)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Compute the absolute line index of the cursor.
 *
 * When `linesOffset` is `null` (tracking lost), falls back to `0` as the
 * base offset so relative positions within the snapshot remain usable.
 *
 * @param snapshot - The snapshot to inspect
 * @returns Absolute line index where the cursor sits
 */
export function cursorLineIndex(snapshot: Snapshot): number {
  return (
    snapshot.lines.length - 1 - snapshot.cursor.y + (snapshot.linesOffset ?? 0)
  );
}

/**
 * Get a single line by absolute index.
 *
 * @param snapshot - The snapshot to read from
 * @param index - Absolute line index
 * @returns The line at the given index, or `undefined` if out of range
 */
export function getLine(
  snapshot: Snapshot,
  index: number,
): RichText | undefined {
  const relIndex = index - (snapshot.linesOffset ?? 0);
  if (relIndex < 0 || relIndex >= snapshot.lines.length) return undefined;
  return snapshot.lines[relIndex] as RichText;
}

/**
 * Collect lines in the absolute range [from, to), stripping leading and
 * trailing blank lines.
 *
 * @param snapshot - The snapshot whose lines to slice
 * @param from - Absolute start index (inclusive)
 * @param to - Absolute end index (exclusive)
 * @returns Trimmed slice of rich-text lines
 */
export function collectLines(
  snapshot: Snapshot,
  from: number,
  to: number,
): RichText[] {
  const offset = snapshot.linesOffset ?? 0;
  const relFrom = Math.max(0, from - offset);
  const relTo = Math.min(snapshot.lines.length, to - offset);
  const { lines } = snapshot;
  let start = relFrom;
  while (
    start < relTo &&
    !richTextToPlainText(lines[start] as RichText).trim()
  ) {
    start++;
  }
  let end = relTo;
  while (
    end > start &&
    !richTextToPlainText(lines[end - 1] as RichText).trim()
  ) {
    end--;
  }
  return lines.slice(start, end) as RichText[];
}

/**
 * Get a single line's plain text by absolute index.
 *
 * @param snapshot - The snapshot to read from
 * @param index - Absolute line index
 * @returns Plain text of the line, or empty string if out of range
 */
export function getPlainLine(snapshot: Snapshot, index: number): string {
  return richTextToPlainText(getLine(snapshot, index) ?? []);
}

/** Collect plain text for each line in an absolute index range. */
export function collectPlainLines(
  snapshot: Snapshot,
  start: number,
  end: number,
): string[] {
  return collectLines(snapshot, start, end).map(richTextToPlainText);
}

/**
 * Scan upward from a given absolute index, testing each line's plain text
 * against a predicate.
 *
 * @param snapshot - The snapshot to scan
 * @param from - Absolute index to start scanning (inclusive)
 * @param maxLines - Maximum number of lines to scan
 * @param predicate - Test function applied to each line's plain text
 * @returns Absolute index of the first matching line, or `-1` if none found
 */
export function findLineAbove(
  snapshot: Snapshot,
  from: number,
  maxLines: number,
  predicate: (text: string) => boolean,
): number {
  const offset = snapshot.linesOffset ?? 0;
  const stop = Math.max(offset, from - maxLines + 1);
  for (let i = from; i >= stop; i--) {
    if (predicate(getPlainLine(snapshot, i))) return i;
  }
  return -1;
}
