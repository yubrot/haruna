/**
 * Headless terminal emulator backed by @xterm/headless.
 *
 * @module
 */

import type { IBufferCell, IBufferLine, IMarker } from "@xterm/headless";
import { Terminal } from "@xterm/headless";
import {
  type RichText,
  richTextToPlainText,
  type Snapshot,
  type StyledSegment,
} from "./snapshot.ts";

/** Options for creating an Emulator. */
export interface EmulatorOptions {
  /** Terminal width in columns. */
  cols: number;
  /** Terminal height in rows. */
  rows: number;
  /** Number of scrollback lines to retain above the viewport. */
  scrollback: number;
}

/** Headless terminal emulator wrapping @xterm/headless. */
export class Emulator {
  private terminal: Terminal;
  private cursorVisible = true;

  // Scrollback lines are immutable in xterm.js once they leave the viewport.
  // We cache their RichText to avoid per-cell reconstruction on every snapshot.
  // A marker placed at the last cached scrollback line tracks how many lines
  // were trimmed (discarded from the buffer front) between snapshots.
  private scrollbackCache: RichText[] = [];
  private scrollbackCacheCols = 0;
  private scrollbackCacheMarker: IMarker | undefined;

  // Cumulative count of lines trimmed from the buffer front.
  // Used as the `linesOffset` field in snapshots.
  // Set to null when tracking is lost (marker disposed or terminal resized).
  private cumulativeTrimCount: number | null = 0;

  /**
   * Create a new Emulator.
   *
   * @param options - Terminal dimensions
   */
  constructor(options: EmulatorOptions) {
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      allowProposedApi: true,
    });
    this.scrollbackCacheCols = options.cols;

    this.registerCursorHandlers();
  }

  private registerCursorHandlers(): void {
    // xterm.js does not expose cursor visibility state, so we intercept
    // DECTCEM sequences (CSI ? 25 h/l) to track it ourselves.
    // Returning false lets xterm.js continue its normal processing.

    // CSI ? Pm h — DECSET (DEC private mode set)
    this.terminal.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        for (let i = 0; i < params.length; i++) {
          if (params[i] === 25) this.cursorVisible = true;
        }
        return false;
      },
    );

    // CSI ? Pm l — DECRST (DEC private mode reset)
    this.terminal.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        for (let i = 0; i < params.length; i++) {
          if (params[i] === 25) this.cursorVisible = false;
        }
        return false;
      },
    );
  }

  /**
   * Feed PTY output data into the virtual terminal.
   *
   * Writes are processed asynchronously. Use {@link flush} to ensure
   * all pending writes are processed before reading state.
   *
   * @param data - Raw bytes from PTY output
   */
  write(data: Uint8Array): void {
    this.terminal.write(data);
  }

  /**
   * Wait for all pending writes to be processed.
   *
   * @returns A promise that resolves when all pending writes are flushed
   */
  flush(): Promise<void> {
    // xterm.js processes writes asynchronously via setTimeout; an empty
    // write's callback fires only after all prior writes complete.
    return new Promise<void>((resolve) => {
      this.terminal.write("", resolve);
    });
  }

  /**
   * Resize the virtual terminal.
   *
   * @param cols - New width in columns
   * @param rows - New height in rows
   */
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
    // Resize rebuilds the buffer — line correspondence is lost.
    this.cumulativeTrimCount = null;
    this.scrollbackCache = [];
    this.scrollbackCacheCols = cols;
    this.scrollbackCacheMarker?.dispose();
    this.scrollbackCacheMarker = undefined;
  }

  /**
   * Capture the current virtual terminal state as a snapshot.
   *
   * Trailing blank lines are stripped from the output. The cursor's `y`
   * coordinate is measured from the end of the resulting `lines` array
   * (0 = last line).
   *
   * @returns A snapshot of the current state
   */
  takeSnapshot(): Snapshot {
    const buffer = this.terminal.buffer.active;
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    const baseY = buffer.baseY;
    const alternate = buffer.type === "alternate";
    const cell = buffer.getNullCell();

    let linesOffset: number | null;
    let cachedLines: RichText[];

    if (alternate) {
      // Normal buffer is frozen during alternate — preserve scrollback state.
      // linesOffset carries forward from the last normal-screen snapshot.
      cachedLines = [];
      linesOffset = this.cumulativeTrimCount;
    } else {
      [cachedLines, linesOffset] = this.resolveScrollback(baseY, cols);
    }

    const allLines: RichText[] = [...cachedLines];
    for (let y = cachedLines.length; y < baseY + rows; y++) {
      const bufferLine = buffer.getLine(y);
      if (!bufferLine) {
        allLines.push("");
        continue;
      }
      allLines.push(buildRichTextLine(bufferLine, cols, cell));
    }

    if (!alternate) {
      this.commitScrollback(allLines.slice(0, baseY), cols, baseY);
    }

    // Compute the absolute cursor line index in allLines
    const xtermCursorY = buffer.cursorY;
    const absCursorLine = baseY + xtermCursorY;

    // Strip trailing blank lines, keeping at least up to the cursor line
    // (if visible) and the last non-blank line.
    let lastNonBlank = -1;
    for (let i = allLines.length - 1; i >= 0; i--) {
      if (richTextToPlainText(allLines[i] as RichText).trim()) {
        lastNonBlank = i;
        break;
      }
    }

    const endIndex = Math.max(
      this.cursorVisible ? absCursorLine + 1 : 0,
      lastNonBlank + 1,
    );
    const lines =
      endIndex < allLines.length ? allLines.slice(0, endIndex) : allLines;

    // cursor.y is measured from the end of lines (0 = last line).
    // Clamp to 0 when the cursor is invisible and its line was stripped.
    const newCursorY = Math.max(0, lines.length - 1 - absCursorLine);

    return {
      lines,
      cursor: {
        x: buffer.cursorX,
        y: newCursorY,
        visible: this.cursorVisible,
      },
      cols,
      rows,
      alternate,
      linesOffset,
      timestamp: Date.now(),
    };
  }

  /**
   * Resolve valid cached scrollback lines and compute the current linesOffset.
   *
   * All `cumulativeTrimCount` state transitions are centralized here:
   * recovery from `null` (tracking loss), marker-based trim detection,
   * and marker disposal.
   *
   * @param baseY - Number of scrollback lines in the buffer
   * @param cols - Current terminal width
   * @returns Tuple of [cached scrollback lines, linesOffset]
   */
  private resolveScrollback(
    baseY: number,
    cols: number,
  ): [RichText[], number | null] {
    // Recovery from tracking loss (resize or previous marker disposal).
    // Report null for THIS snapshot, reset to 0 for the next one.
    if (this.cumulativeTrimCount === null) {
      this.cumulativeTrimCount = 0;
      return [[], null];
    }

    const cached = this.scrollbackCache;
    if (cached.length === 0 || baseY === 0) {
      return [[], this.cumulativeTrimCount];
    }

    if (cols !== this.scrollbackCacheCols || baseY < cached.length) {
      return [[], this.cumulativeTrimCount];
    }

    const marker = this.scrollbackCacheMarker;
    if (!marker || marker.isDisposed) {
      // Marker trimmed away — tracking lost. Report null, reset internally.
      this.cumulativeTrimCount = 0;
      return [[], null];
    }

    // The marker was placed at the last cached scrollback line.
    // If lines were trimmed, marker.line decreases by the trim count.
    const originalLine = cached.length - 1;
    const trimCount = originalLine - marker.line;
    if (trimCount > 0) {
      this.cumulativeTrimCount += trimCount;
      return [
        cached.slice(trimCount, trimCount + baseY),
        this.cumulativeTrimCount,
      ];
    }

    return [cached.slice(0, baseY), this.cumulativeTrimCount];
  }

  /**
   * Save scrollback lines to the cache and place a marker to track future trimming.
   *
   * @param scrollbackLines - The scrollback portion of allLines
   * @param cols - Current terminal width
   * @param baseY - Number of scrollback lines in the buffer
   */
  private commitScrollback(
    scrollbackLines: RichText[],
    cols: number,
    baseY: number,
  ): void {
    this.scrollbackCache = scrollbackLines;
    this.scrollbackCacheCols = cols;

    this.scrollbackCacheMarker?.dispose();
    this.scrollbackCacheMarker = undefined;
    if (baseY === 0) return;

    // registerMarker(offset) places the marker at absolute line
    // (baseY + cursorY + offset). We want it at targetLine = baseY - 1:
    //   offset = (baseY - 1) - (baseY + cursorY) = -1 - cursorY
    const cursorY = this.terminal.buffer.active.cursorY;
    const offset = -1 - cursorY;
    this.scrollbackCacheMarker =
      this.terminal.registerMarker(offset) ?? undefined;
  }

  /** Release resources held by the underlying terminal. */
  dispose(): void {
    this.scrollbackCacheMarker?.dispose();
    this.terminal.dispose();
  }
}

/**
 * Extracted SGR attributes from a cell, keyed for grouping.
 *
 * Property names (except `key`) mirror {@link StyledSegment} so that
 * spreading directly produces a valid segment.
 */
interface CellAttrs {
  /** Compact string key for equality comparison between cells. Empty = default. */
  key: string;
  /** Foreground color, if non-default. */
  fg?: number | string;
  /** Background color, if non-default. */
  bg?: number | string;
  /** Bold attribute. */
  b?: true;
  /** Dim attribute. */
  d?: true;
  /** Italic attribute. */
  i?: true;
  /** Underline attribute. */
  u?: true;
  /** Strikethrough attribute. */
  s?: true;
  /** Inverse attribute. */
  v?: true;
  /** Overline attribute. */
  o?: true;
}

/** Default (no-attribute) cell attrs singleton. */
const DEFAULT_ATTRS: CellAttrs = { key: "" };

/**
 * Extract SGR attributes from a cell into a plain object.
 *
 * @param cell - The buffer cell to read attributes from
 * @returns Extracted attributes with a comparable key
 */
function extractCellAttrs(cell: IBufferCell): CellAttrs {
  if (cell.isAttributeDefault() && cell.isFgDefault() && cell.isBgDefault()) {
    return DEFAULT_ATTRS;
  }

  const attrs: CellAttrs = { key: "" };
  const keyParts: string[] = [];

  if (cell.isBold()) {
    attrs.b = true;
    keyParts.push("B");
  }
  if (cell.isDim()) {
    attrs.d = true;
    keyParts.push("D");
  }
  if (cell.isItalic()) {
    attrs.i = true;
    keyParts.push("I");
  }
  if (cell.isUnderline()) {
    attrs.u = true;
    keyParts.push("U");
  }
  if (cell.isStrikethrough()) {
    attrs.s = true;
    keyParts.push("S");
  }
  if (cell.isInverse()) {
    attrs.v = true;
    keyParts.push("V");
  }
  if (cell.isOverline()) {
    attrs.o = true;
    keyParts.push("O");
  }
  if (!cell.isFgDefault()) {
    if (cell.isFgRGB()) {
      const hex = `#${cell.getFgColor().toString(16).padStart(6, "0")}`;
      attrs.fg = hex;
      keyParts.push(`f${hex}`);
    } else {
      const idx = cell.getFgColor();
      attrs.fg = idx;
      keyParts.push(`f${idx}`);
    }
  }
  if (!cell.isBgDefault()) {
    if (cell.isBgRGB()) {
      const hex = `#${cell.getBgColor().toString(16).padStart(6, "0")}`;
      attrs.bg = hex;
      keyParts.push(`b${hex}`);
    } else {
      const idx = cell.getBgColor();
      attrs.bg = idx;
      keyParts.push(`b${idx}`);
    }
  }

  attrs.key = keyParts.join(",");
  return attrs;
}

/**
 * Build a {@link RichText} line from a buffer line's cells.
 *
 * @param bufferLine - The xterm.js buffer line
 * @param cols - Terminal width in columns
 * @param cell - Reusable cell object for performance
 * @returns The rich text representation of the line
 */
function buildRichTextLine(
  bufferLine: IBufferLine,
  cols: number,
  cell: IBufferCell,
): RichText {
  // Single pass: collect runs of characters grouped by identical attributes.
  // Attributes are extracted eagerly so we don't need to re-read the cell.
  const runs: { text: string; attrs: CellAttrs }[] = [];
  let currentText = "";
  let currentAttrs: CellAttrs = DEFAULT_ATTRS;

  for (let x = 0; x < cols; x++) {
    if (!bufferLine.getCell(x, cell)) break;

    // Skip zero-width cells (second half of wide characters)
    if (cell.getWidth() === 0) continue;

    const chars = cell.getChars();
    const attrs = extractCellAttrs(cell);

    if (attrs.key === currentAttrs.key) {
      currentText += chars || " ";
    } else {
      if (currentText.length > 0) {
        runs.push({ text: currentText, attrs: currentAttrs });
      }
      currentText = chars || " ";
      currentAttrs = attrs;
    }
  }
  if (currentText.length > 0) {
    runs.push({ text: currentText, attrs: currentAttrs });
  }

  // Trim trailing whitespace to match xterm.js translateToString(true) behavior.
  for (let last = runs.at(-1); last; last = runs.at(-1)) {
    const trimmed = last.text.replace(/\s+$/, "");
    if (trimmed.length === 0) {
      runs.pop();
    } else {
      last.text = trimmed;
      break;
    }
  }

  if (runs.length === 0) {
    return "";
  }

  // If all runs are plain text (no styling), return a single string.
  if (runs.every((run) => run.attrs.key === "")) {
    return runs.map((run) => run.text).join("");
  }

  // Convert runs into RichSegment array.
  return runs.map(({ attrs: { key, ...style }, text }) =>
    key === "" ? text : { ...style, t: text },
  );
}
