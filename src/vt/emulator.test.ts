import { describe, expect, test } from "bun:test";
import {
  type RichText,
  richTextToPlainText,
  type StyledSegment,
} from "../vt/snapshot.ts";
import { Emulator } from "./emulator.ts";

const encoder = new TextEncoder();

async function write(vt: Emulator, text: string): Promise<void> {
  vt.write(encoder.encode(text));
  await vt.flush();
}

/** Get a line from snapshot, throwing if out of bounds. */
function getLine(lines: RichText[], index: number): RichText {
  if (index < 0 || index >= lines.length)
    throw new Error(`No line at index ${index}`);
  return lines[index] as RichText;
}

describe("Emulator", () => {
  test("captures plain text in snapshot", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "hello");
    const snap = vt.takeSnapshot();
    expect(snap).toMatchObject({ cols: 80, rows: 24 });
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("hello");
    vt.dispose();
  });

  test("plain text collapses to string RichText", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "hello");
    const snap = vt.takeSnapshot();
    // Should be "hello", not an array
    expect(snap.lines[0]).toEqual("hello");
    vt.dispose();
  });

  test("captures multiline text", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "line1\r\nline2\r\nline3");
    const snap = vt.takeSnapshot();
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("line1");
    expect(richTextToPlainText(snap.lines[1] as RichText)).toBe("line2");
    expect(richTextToPlainText(snap.lines[2] as RichText)).toBe("line3");
    vt.dispose();
  });

  test("tracks cursor position", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "hello");
    const snap = vt.takeSnapshot();
    // cursor.y = 0 means cursor is on the last line (end-based)
    expect(snap.cursor).toMatchObject({ x: 5, y: 0 });
    vt.dispose();
  });

  test("tracks cursor position after move sequence", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // CUP: move cursor to row 5, col 10 (1-based in escape sequence)
    await write(vt, "\x1b[5;10H");
    const snap = vt.takeSnapshot();
    // Absolute cursor line = 4 (0-based), lines.length = 5 (cursor keeps lines up to row 5)
    // cursor.y (end-based) = lines.length - 1 - 4 = 0
    expect(snap.cursor).toMatchObject({ x: 9, y: 0 });
    vt.dispose();
  });

  test("cursor is visible by default", () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    const snap = vt.takeSnapshot();
    expect(snap.cursor.visible).toBe(true);
    vt.dispose();
  });

  test("tracks cursor hide via DECTCEM", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // CSI ? 25 l — hide cursor
    await write(vt, "\x1b[?25l");
    const snap = vt.takeSnapshot();
    expect(snap.cursor.visible).toBe(false);
    vt.dispose();
  });

  test("tracks cursor show via DECTCEM", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "\x1b[?25l"); // hide
    await write(vt, "\x1b[?25h"); // show
    const snap = vt.takeSnapshot();
    expect(snap.cursor.visible).toBe(true);
    vt.dispose();
  });

  test("handles DECTCEM in multi-parameter sequence", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // CSI ? 7 ; 25 l — reset auto-wrap and hide cursor
    await write(vt, "\x1b[?7;25l");
    const snap = vt.takeSnapshot();
    expect(snap.cursor.visible).toBe(false);
    vt.dispose();
  });

  test("resize changes snapshot dimensions", () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    vt.resize(120, 40);
    const snap = vt.takeSnapshot();
    expect(snap).toMatchObject({ cols: 120, rows: 40 });
    // Trailing blank lines are stripped; empty terminal has no content lines
    // but cursor is visible at origin, so at least 1 line is kept
    expect(snap.lines.length).toBeLessThanOrEqual(40);
    vt.dispose();
  });

  test("snapshot strips trailing blank lines", async () => {
    const vt = new Emulator({ cols: 80, rows: 5, scrollback: 0 });
    await write(vt, "a\r\nb\r\nc");
    const snap = vt.takeSnapshot();
    // Only 3 content lines; trailing blanks stripped (cursor is on line 2 = "c")
    expect(snap.lines).toHaveLength(3);
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("a");
    expect(richTextToPlainText(snap.lines[1] as RichText)).toBe("b");
    expect(richTextToPlainText(snap.lines[2] as RichText)).toBe("c");
    vt.dispose();
  });

  test("snapshot has timestamp", () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    const before = Date.now();
    const snap = vt.takeSnapshot();
    const after = Date.now();
    expect(snap.timestamp).toBeGreaterThanOrEqual(before);
    expect(snap.timestamp).toBeLessThanOrEqual(after);
    vt.dispose();
  });

  test("bold SGR produces StyledSegment with b attribute", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // SGR 1 = bold, then reset
    await write(vt, "\x1b[1mbold\x1b[0m plain");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    // Should have a bold span followed by plain text
    expect(line.length).toBe(2);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ b: true, t: "bold" });
    expect(line[1]).toBe(" plain");
    vt.dispose();
  });

  test("foreground palette color produces StyledSegment with fg", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // SGR 31 = red foreground (palette index 1)
    await write(vt, "\x1b[31mred\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(typeof span.fg).toBe("number");
    expect(span.t).toBe("red");
    vt.dispose();
  });

  test("256-color palette produces numeric fg", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // SGR 38;5;196 = 256-color palette index 196
    await write(vt, "\x1b[38;5;196mcolorful\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ fg: 196, t: "colorful" });
    vt.dispose();
  });

  test("RGB color produces hex string fg", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // SGR 38;2;255;128;0 = RGB #ff8000
    await write(vt, "\x1b[38;2;255;128;0mrgb\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ fg: "#ff8000", t: "rgb" });
    vt.dispose();
  });

  test("background color produces StyledSegment with bg", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // SGR 42 = green background (palette index 2)
    await write(vt, "\x1b[42mbg\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(typeof span.bg).toBe("number");
    expect(span.t).toBe("bg");
    vt.dispose();
  });

  test("multiple SGR attributes combine in a single span", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // SGR 1;3;4 = bold + italic + underline
    await write(vt, "\x1b[1;3;4mstyled\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ b: true, i: true, u: true, t: "styled" });
    vt.dispose();
  });

  test("consecutive segments with different styles become separate spans", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // Red "hello" + green "world"
    await write(vt, "\x1b[31mhello\x1b[32mworld\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(2);
    const span1 = line[0] as StyledSegment;
    const span2 = line[1] as StyledSegment;
    expect(span1.t).toBe("hello");
    expect(span2.t).toBe("world");
    // Both should have fg but different values
    expect(span1.fg).not.toBe(span2.fg);
    vt.dispose();
  });

  test("trailing blank lines are stripped", async () => {
    const vt = new Emulator({ cols: 80, rows: 5, scrollback: 0 });
    await write(vt, "text");
    const snap = vt.takeSnapshot();
    // Only 1 line ("text") since trailing blanks are stripped
    expect(snap.lines).toHaveLength(1);
    expect(snap.lines[0]).toEqual("text");
    vt.dispose();
  });

  test("trailing whitespace is trimmed from plain text", async () => {
    const vt = new Emulator({ cols: 10, rows: 1, scrollback: 0 });
    await write(vt, "hi");
    const snap = vt.takeSnapshot();
    // Should not include trailing spaces to fill the 10-column width
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("hi");
    vt.dispose();
  });

  // --- Wide characters (CJK) ---

  test("wide character occupies two columns", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "あいう");
    const snap = vt.takeSnapshot();
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("あいう");
    // Cursor should advance by 2 per wide char
    expect(snap.cursor.x).toBe(6);
    vt.dispose();
  });

  test("wide characters mixed with ASCII", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "hi日本語ok");
    const snap = vt.takeSnapshot();
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("hi日本語ok");
    vt.dispose();
  });

  test("wide character with SGR attributes", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // Bold CJK text followed by plain ASCII
    await write(vt, "\x1b[1m漢字\x1b[0m end");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(2);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ b: true, t: "漢字" });
    expect(line[1]).toBe(" end");
    vt.dispose();
  });

  // --- Remaining SGR attributes ---

  test("dim SGR produces StyledSegment with d attribute", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "\x1b[2mdim\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ d: true, t: "dim" });
    vt.dispose();
  });

  test("strikethrough SGR produces StyledSegment with s attribute", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "\x1b[9mstrike\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ s: true, t: "strike" });
    vt.dispose();
  });

  test("inverse SGR produces StyledSegment with v attribute", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "\x1b[7minverse\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ v: true, t: "inverse" });
    vt.dispose();
  });

  test("overline SGR produces StyledSegment with o attribute", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "\x1b[53moverline\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ o: true, t: "overline" });
    vt.dispose();
  });

  // --- Background color variants ---

  test("256-color palette produces numeric bg", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // SGR 48;5;42 = 256-color background palette index 42
    await write(vt, "\x1b[48;5;42mbg256\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ bg: 42, t: "bg256" });
    vt.dispose();
  });

  test("RGB background produces hex string bg", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // SGR 48;2;0;128;255 = RGB background #0080ff
    await write(vt, "\x1b[48;2;0;128;255mbgrgb\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ bg: "#0080ff", t: "bgrgb" });
    vt.dispose();
  });

  // --- Trailing whitespace trimming edge cases ---

  test("trailing whitespace after styled span is trimmed", async () => {
    const vt = new Emulator({ cols: 20, rows: 1, scrollback: 0 });
    // Bold "hi" followed by spaces filling remaining columns
    await write(vt, "\x1b[1mhi\x1b[0m");
    const snap = vt.takeSnapshot();
    const line = getLine(snap.lines, 0);
    // Should only contain the bold span, trailing default spaces trimmed
    expect(line.length).toBe(1);
    const span = line[0] as StyledSegment;
    expect(span).toMatchObject({ b: true, t: "hi" });
    vt.dispose();
  });

  test("line with only spaces produces empty RichText", async () => {
    const vt = new Emulator({ cols: 80, rows: 3, scrollback: 0 });
    // Write on line 0 and line 2, leaving line 1 untouched
    await write(vt, "first\r\n\r\nthird");
    const snap = vt.takeSnapshot();
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("first");
    // Line 1 was skipped — only default spaces, should be ""
    expect(snap.lines[1]).toEqual("");
    expect(richTextToPlainText(snap.lines[2] as RichText)).toBe("third");
    vt.dispose();
  });

  // --- Resize with existing content ---

  test("resize preserves existing text content", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "hello\r\nworld");
    vt.resize(80, 10);
    const snap = vt.takeSnapshot();
    // Trailing blank lines are stripped
    expect(snap.lines.length).toBeLessThanOrEqual(10);
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("hello");
    expect(richTextToPlainText(snap.lines[1] as RichText)).toBe("world");
    vt.dispose();
  });

  // --- Flush behavior ---

  test("multiple writes before a single flush are all processed", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    // Write three chunks without flushing in between
    vt.write(encoder.encode("aaa"));
    vt.write(encoder.encode("bbb"));
    vt.write(encoder.encode("ccc"));
    await vt.flush();
    const snap = vt.takeSnapshot();
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("aaabbbccc");
    vt.dispose();
  });

  // --- Scrollback (unified lines) ---

  test("no scrollback: trailing blank lines are stripped", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    await write(vt, "hello");
    const snap = vt.takeSnapshot();
    // Only 1 content line; trailing blanks stripped
    expect(snap.lines).toHaveLength(1);
    vt.dispose();
  });

  test("scrollback lines are prepended to viewport in unified lines", async () => {
    const vt = new Emulator({ cols: 80, rows: 3, scrollback: 10 });
    // Write 5 lines into a 3-row viewport — first 2 lines scroll out
    await write(vt, "line1\r\nline2\r\nline3\r\nline4\r\nline5");
    const snap = vt.takeSnapshot();
    // Total lines = 2 scrollback + 3 viewport = 5
    expect(snap.lines).toHaveLength(5);
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("line1");
    expect(richTextToPlainText(snap.lines[1] as RichText)).toBe("line2");
    // Viewport = lines.slice(-rows)
    expect(richTextToPlainText(snap.lines[2] as RichText)).toBe("line3");
    expect(richTextToPlainText(snap.lines[3] as RichText)).toBe("line4");
    expect(richTextToPlainText(snap.lines[4] as RichText)).toBe("line5");
    vt.dispose();
  });

  test("viewport is derivable from lines.slice(-rows)", async () => {
    const vt = new Emulator({ cols: 80, rows: 3, scrollback: 10 });
    await write(vt, "line1\r\nline2\r\nline3\r\nline4\r\nline5");
    const snap = vt.takeSnapshot();
    const viewport = snap.lines.slice(-snap.rows);
    expect(viewport).toHaveLength(3);
    expect(richTextToPlainText(viewport[0] as RichText)).toBe("line3");
    expect(richTextToPlainText(viewport[1] as RichText)).toBe("line4");
    expect(richTextToPlainText(viewport[2] as RichText)).toBe("line5");
    vt.dispose();
  });

  test("scrollback discards oldest lines when limit is exceeded", async () => {
    const vt = new Emulator({ cols: 80, rows: 2, scrollback: 3 });
    // Write 7 lines into a 2-row viewport with scrollback of 3
    // Lines 1-5 scroll out, but only last 3 are kept in scrollback
    await write(
      vt,
      "line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6\r\nline7",
    );
    const snap = vt.takeSnapshot();
    // Total: scrollback (at most 3) + viewport (2) = at most 5
    expect(snap.lines.length).toBeLessThanOrEqual(5);
    // Viewport = last 2 lines
    const viewport = snap.lines.slice(-snap.rows);
    expect(richTextToPlainText(viewport[0] as RichText)).toBe("line6");
    expect(richTextToPlainText(viewport[1] as RichText)).toBe("line7");
    // The scrollback portion (most recent scrollback line should be line5)
    const scrollback = snap.lines.slice(0, -snap.rows);
    expect(scrollback.length).toBeLessThanOrEqual(3);
    expect(
      richTextToPlainText(scrollback[scrollback.length - 1] as RichText),
    ).toBe("line5");
    vt.dispose();
  });

  // --- Scrollback cache ---

  test("cached scrollback lines reuse identical objects across snapshots", async () => {
    const vt = new Emulator({ cols: 80, rows: 3, scrollback: 10 });
    // Write 5 lines → 2 scroll into scrollback
    await write(vt, "line1\r\nline2\r\nline3\r\nline4\r\nline5");
    const snap1 = vt.takeSnapshot();

    // Write one more line → viewport changes, scrollback grows by 1
    await write(vt, "\r\nline6");
    const snap2 = vt.takeSnapshot();

    // The first 2 scrollback lines should be the exact same object references
    expect(snap2.lines[0]).toBe(snap1.lines[0]);
    expect(snap2.lines[1]).toBe(snap1.lines[1]);
    vt.dispose();
  });

  test("cache is invalidated on column resize", async () => {
    const vt = new Emulator({ cols: 80, rows: 3, scrollback: 10 });
    // Write a line long enough to wrap at 40 cols but not at 80
    const longLine = "A".repeat(60);
    await write(vt, `${longLine}\r\nB\r\nC\r\nD\r\nE`);
    const snap1 = vt.takeSnapshot();
    expect(richTextToPlainText(snap1.lines[0] as RichText)).toBe(longLine);

    vt.resize(40, 3);
    const snap2 = vt.takeSnapshot();

    // After resize, cols changed — scrollback cache should be rebuilt.
    // The long line wraps differently, so content changes.
    expect(snap2.cols).toBe(40);
    // Verify the snapshot is internally consistent (no stale cached data)
    expect(snap2.lines.length).toBeGreaterThanOrEqual(3);
    vt.dispose();
  });

  test("cache survives scrollback trimming via marker tracking", async () => {
    const vt = new Emulator({ cols: 80, rows: 2, scrollback: 3 });
    // Fill scrollback to limit: 5 lines → 3 scrollback + 2 viewport
    await write(vt, "A\r\nB\r\nC\r\nD\r\nE");
    const snap1 = vt.takeSnapshot();
    expect(richTextToPlainText(snap1.lines[0] as RichText)).toBe("A");

    // Add more lines → scrollback trims oldest (A, B removed)
    await write(vt, "\r\nF\r\nG");
    const snap2 = vt.takeSnapshot();

    // A and B should be gone; C should now be the first scrollback line
    expect(richTextToPlainText(snap2.lines[0] as RichText)).toBe("C");
    // Surviving cached line C should be reused by reference
    expect(snap2.lines[0]).toBe(snap1.lines[2]);
    // Viewport should be correct
    const viewport = snap2.lines.slice(-snap2.rows);
    expect(richTextToPlainText(viewport[0] as RichText)).toBe("F");
    expect(richTextToPlainText(viewport[1] as RichText)).toBe("G");
    vt.dispose();
  });

  test("cache is fully invalidated when all scrollback lines are trimmed", async () => {
    const vt = new Emulator({ cols: 80, rows: 2, scrollback: 2 });
    // Fill scrollback: 4 lines → 2 scrollback + 2 viewport
    await write(vt, "A\r\nB\r\nC\r\nD");
    const snap1 = vt.takeSnapshot();
    expect(richTextToPlainText(snap1.lines[0] as RichText)).toBe("A");

    // Trim all scrollback lines (A, B gone, C and D scroll out too)
    await write(vt, "\r\nE\r\nF\r\nG\r\nH");
    const snap2 = vt.takeSnapshot();

    // All original scrollback lines are gone
    expect(richTextToPlainText(snap2.lines[0] as RichText)).toBe("E");
    const viewport = snap2.lines.slice(-snap2.rows);
    expect(richTextToPlainText(viewport[0] as RichText)).toBe("G");
    expect(richTextToPlainText(viewport[1] as RichText)).toBe("H");
    vt.dispose();
  });

  test("cache works across multiple trims at scrollback limit", async () => {
    const vt = new Emulator({ cols: 80, rows: 2, scrollback: 3 });
    // Fill to limit
    await write(vt, "A\r\nB\r\nC\r\nD\r\nE");
    vt.takeSnapshot(); // [A,B,C | D,E]

    // First trim: 1 line
    await write(vt, "\r\nF");
    const snap1 = vt.takeSnapshot(); // [B,C,D | E,F]
    expect(richTextToPlainText(snap1.lines[0] as RichText)).toBe("B");

    // Second trim: 2 lines
    await write(vt, "\r\nG\r\nH");
    const snap2 = vt.takeSnapshot(); // [D,E,F | G,H]
    expect(richTextToPlainText(snap2.lines[0] as RichText)).toBe("D");
    expect(richTextToPlainText(snap2.lines[1] as RichText)).toBe("E");
    expect(richTextToPlainText(snap2.lines[2] as RichText)).toBe("F");

    // D and E should be reused from snap1's cache
    expect(snap2.lines[0]).toBe(snap1.lines[2]);
    expect(snap2.lines[1]).toBe(snap1.lines[3]);
    vt.dispose();
  });

  test("snapshot is correct after multiple incremental writes with scrollback", async () => {
    const vt = new Emulator({ cols: 80, rows: 2, scrollback: 10 });
    // Build up scrollback gradually with multiple takeSnapshot() calls
    await write(vt, "A\r\nB\r\nC");
    vt.takeSnapshot(); // prime the cache

    await write(vt, "\r\nD");
    vt.takeSnapshot(); // extend cache

    await write(vt, "\r\nE\r\nF");
    const snap = vt.takeSnapshot();

    // Total: 4 scrollback + 2 viewport = 6
    expect(snap.lines).toHaveLength(6);
    expect(richTextToPlainText(snap.lines[0] as RichText)).toBe("A");
    expect(richTextToPlainText(snap.lines[1] as RichText)).toBe("B");
    expect(richTextToPlainText(snap.lines[2] as RichText)).toBe("C");
    expect(richTextToPlainText(snap.lines[3] as RichText)).toBe("D");
    expect(richTextToPlainText(snap.lines[4] as RichText)).toBe("E");
    expect(richTextToPlainText(snap.lines[5] as RichText)).toBe("F");
    vt.dispose();
  });

  // --- linesOffset ---

  test("linesOffset starts at 0", () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 0 });
    const snap = vt.takeSnapshot();
    expect(snap.linesOffset).toBe(0);
    vt.dispose();
  });

  test("linesOffset increments when scrollback lines are trimmed", async () => {
    const vt = new Emulator({ cols: 80, rows: 2, scrollback: 3 });
    // Write 5 lines: 3 scrollback + 2 viewport, no trimming yet
    await write(vt, "A\r\nB\r\nC\r\nD\r\nE");
    const snap1 = vt.takeSnapshot();
    expect(snap1.linesOffset).toBe(0);

    // Write 1 more: scrollback overflows, 1 line trimmed (marker survives)
    await write(vt, "\r\nF");
    const snap2 = vt.takeSnapshot();
    expect(snap2.linesOffset).toBe(1);
    vt.dispose();
  });

  test("linesOffset is null on first snapshot after resize, then recovers", async () => {
    const vt = new Emulator({ cols: 80, rows: 3, scrollback: 10 });
    await write(vt, "A\r\nB\r\nC\r\nD\r\nE");
    const snap1 = vt.takeSnapshot();
    expect(snap1.linesOffset).toBe(0);

    vt.resize(80, 3);
    const snap2 = vt.takeSnapshot();
    // Resize loses tracking — first snapshot reports null
    expect(snap2.linesOffset).toBeNull();

    const snap3 = vt.takeSnapshot();
    // Next snapshot recovers tracking
    expect(snap3.linesOffset).toBe(0);
    vt.dispose();
  });

  test("linesOffset becomes null when marker is lost (all cached lines trimmed)", async () => {
    const vt = new Emulator({ cols: 80, rows: 2, scrollback: 2 });
    // Fill scrollback: 4 lines → 2 scrollback + 2 viewport
    await write(vt, "A\r\nB\r\nC\r\nD");
    const snap1 = vt.takeSnapshot();
    expect(snap1.linesOffset).toBe(0);

    // Trim all scrollback lines (marker disposed)
    await write(vt, "\r\nE\r\nF\r\nG\r\nH");
    const snap2 = vt.takeSnapshot();
    // Marker was disposed — cannot determine exact trim count
    expect(snap2.linesOffset).toBeNull();
    vt.dispose();
  });

  // --- Alternate screen ---

  test("alternate is true during alternate screen", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 10 });
    await write(vt, "hello");
    const snap1 = vt.takeSnapshot();
    expect(snap1.alternate).toBe(false);
    expect(snap1.linesOffset).toBe(0);

    // Enter alternate screen (DECSET 1049)
    await write(vt, "\x1b[?1049h");
    await write(vt, "alt content");
    const snap2 = vt.takeSnapshot();
    expect(snap2.alternate).toBe(true);
    // linesOffset is preserved from last normal-screen snapshot
    expect(snap2.linesOffset).toBe(0);
    vt.dispose();
  });

  test("linesOffset resumes after alternate screen exit", async () => {
    const vt = new Emulator({ cols: 80, rows: 24, scrollback: 10 });
    await write(vt, "hello");
    const snap1 = vt.takeSnapshot();
    expect(snap1.alternate).toBe(false);
    expect(snap1.linesOffset).toBe(0);

    // Enter and exit alternate screen
    await write(vt, "\x1b[?1049h");
    await write(vt, "alt content");
    const snap2 = vt.takeSnapshot();
    expect(snap2.alternate).toBe(true);
    expect(snap2.linesOffset).toBe(0);

    await write(vt, "\x1b[?1049l");
    const snap3 = vt.takeSnapshot();
    expect(snap3.alternate).toBe(false);
    expect(snap3.linesOffset).toBe(0);
    // Normal content is preserved
    expect(richTextToPlainText(snap3.lines[0] as RichText)).toBe("hello");
    vt.dispose();
  });

  test("linesOffset recovers after marker loss on normal screen", async () => {
    const vt = new Emulator({ cols: 80, rows: 2, scrollback: 2 });
    // Fill scrollback: 4 lines → 2 scrollback + 2 viewport
    await write(vt, "A\r\nB\r\nC\r\nD");
    const snap1 = vt.takeSnapshot();
    expect(snap1.linesOffset).toBe(0);

    // Trim all scrollback lines (marker disposed) → linesOffset becomes null
    await write(vt, "\r\nE\r\nF\r\nG\r\nH");
    const snap2 = vt.takeSnapshot();
    expect(snap2.linesOffset).toBeNull();

    // Next snapshot recovers tracking — offset restarts from 0 plus any
    // new trims since recovery
    const snap3 = vt.takeSnapshot();
    expect(snap3.linesOffset).toBe(0);
    vt.dispose();
  });

  // --- cursor.y (end-based) ---

  test("cursor.y is 0 when cursor is on the last line", async () => {
    const vt = new Emulator({ cols: 80, rows: 5, scrollback: 0 });
    await write(vt, "hello");
    const snap = vt.takeSnapshot();
    expect(snap.cursor.y).toBe(0);
    vt.dispose();
  });

  test("cursor.y reflects distance from end of lines", async () => {
    const vt = new Emulator({ cols: 80, rows: 5, scrollback: 0 });
    await write(vt, "line1\r\nline2\r\nline3");
    const snap = vt.takeSnapshot();
    // Cursor is on line3 (the last line with content), y should be 0
    expect(snap.cursor.y).toBe(0);
    vt.dispose();
  });
});
