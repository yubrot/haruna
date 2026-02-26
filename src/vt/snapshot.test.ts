import { describe, expect, test } from "bun:test";
import { snapshot } from "./__testing.ts";
import {
  applySnapshotDiff,
  collectLines,
  computeSnapshotDiff,
  cursorLineIndex,
  findLineAbove,
  getLine,
  type RichText,
  richTextEqual,
  richTextLinesEqual,
  richTextToPlainText,
  type Snapshot,
  snapshotsEqual,
} from "./snapshot.ts";

describe("snapshotsEqual", () => {
  test("identical snapshots are equal (timestamps ignored)", () => {
    const a = snapshot(["hello", "world"]);
    const b = snapshot(["hello", "world"], { timestamp: 2000 });
    expect(snapshotsEqual(a, b)).toBe(true);
  });

  test("different linesOffset is not equal", () => {
    const a = snapshot(["hello", "world"]);
    const b = snapshot(["hello", "world"], { linesOffset: 10 });
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("null linesOffset is not equal to zero", () => {
    const a = snapshot(["hello", "world"]);
    const b = snapshot(["hello", "world"], { linesOffset: null });
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("different text content is not equal", () => {
    const a = snapshot(["hello", "world"]);
    const b = snapshot(["hello", "earth"]);
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("different cursor position is not equal", () => {
    const a = snapshot(["hello", "world"]);
    const b = snapshot(["hello", "world"], {
      cursor: { x: 5, y: 3, visible: true },
    });
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("different cursor visibility is not equal", () => {
    const a = snapshot(["hello", "world"]);
    const b = snapshot(["hello", "world"], {
      cursor: { x: 0, y: 0, visible: false },
    });
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("different alternate is not equal", () => {
    const a = snapshot(["hello", "world"]);
    const b = snapshot(["hello", "world"], { alternate: true });
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("different dimensions is not equal", () => {
    const a = snapshot(["hello", "world"]);
    const b = snapshot(["hello", "world"], { cols: 120, rows: 40 });
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("different line counts is not equal", () => {
    const a = snapshot(["a", "b", "c"]);
    const b = snapshot(["a", "b"]);
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("different style attributes is not equal", () => {
    const a = snapshot(["hello", "world"]);
    const b = snapshot([[{ b: true, t: "hello" }], "world"]);
    expect(snapshotsEqual(a, b)).toBe(false);
  });
});

describe("cursorLineIndex", () => {
  test("cursor at last line (y=0)", () => {
    const s = snapshot(["a", "b", "c"], {
      cursor: { x: 0, y: 0, visible: true },
    });
    expect(cursorLineIndex(s)).toBe(2);
  });

  test("cursor at first line of 3-line snapshot", () => {
    const s = snapshot(["a", "b", "c"], {
      cursor: { x: 0, y: 2, visible: true },
    });
    expect(cursorLineIndex(s)).toBe(0);
  });

  test("cursor with scrollback lines", () => {
    const s = snapshot(["s0", "s1", "a", "b", "c"], {
      cursor: { x: 0, y: 1, visible: true },
    });
    expect(cursorLineIndex(s)).toBe(3);
  });

  test("returns absolute index when linesOffset is non-zero", () => {
    const s = snapshot(["a", "b", "c"], {
      cursor: { x: 0, y: 0, visible: true },
      linesOffset: 10,
    });
    expect(cursorLineIndex(s)).toBe(12);
  });

  test("falls back to offset 0 when linesOffset is null", () => {
    const s = snapshot(["a", "b", "c"], {
      cursor: { x: 0, y: 0, visible: true },
      linesOffset: null,
    });
    expect(cursorLineIndex(s)).toBe(2);
  });
});

describe("getLine", () => {
  test("returns line at absolute index", () => {
    const s = snapshot(["a", "b", "c"]);
    expect(getLine(s, 1)).toBe("b");
  });

  test("returns line with non-zero linesOffset", () => {
    const s = snapshot(["a", "b", "c"], { linesOffset: 10 });
    expect(getLine(s, 11)).toBe("b");
  });

  test("returns undefined for out-of-range index", () => {
    const s = snapshot(["a", "b"], { linesOffset: 5 });
    expect(getLine(s, 4)).toBeUndefined();
    expect(getLine(s, 7)).toBeUndefined();
    expect(getLine(s, -1)).toBeUndefined();
  });

  test("falls back to offset 0 when linesOffset is null", () => {
    const s = snapshot(["a", "b", "c"], { linesOffset: null });
    expect(getLine(s, 1)).toBe("b");
  });
});

describe("collectLines", () => {
  test("returns lines in absolute range", () => {
    const s = snapshot(["a", "b", "c", "d"]);
    expect(collectLines(s, 1, 3)).toEqual(["b", "c"]);
  });

  test("strips leading blank lines", () => {
    const s = snapshot(["", "", "a", "b"]);
    expect(collectLines(s, 0, 4)).toEqual(["a", "b"]);
  });

  test("strips trailing blank lines", () => {
    const s = snapshot(["a", "b", "", ""]);
    expect(collectLines(s, 0, 4)).toEqual(["a", "b"]);
  });

  test("strips both leading and trailing blank lines", () => {
    const s = snapshot(["", "a", "b", ""]);
    expect(collectLines(s, 0, 4)).toEqual(["a", "b"]);
  });

  test("preserves internal blank lines", () => {
    const s = snapshot(["a", "", "b"]);
    expect(collectLines(s, 0, 3)).toEqual(["a", "", "b"]);
  });

  test("returns empty array when all lines are blank", () => {
    const s = snapshot(["", "", ""]);
    expect(collectLines(s, 0, 3)).toEqual([]);
  });

  test("returns empty array for empty range", () => {
    const s = snapshot(["a", "b"]);
    expect(collectLines(s, 1, 1)).toEqual([]);
  });

  test("accepts absolute indices with non-zero linesOffset", () => {
    const s = snapshot(["a", "b", "c", "d"], { linesOffset: 10 });
    expect(collectLines(s, 11, 13)).toEqual(["b", "c"]);
  });

  test("falls back to offset 0 when linesOffset is null", () => {
    const s = snapshot(["a", "b", "c"], { linesOffset: null });
    expect(collectLines(s, 0, 3)).toEqual(["a", "b", "c"]);
  });

  test("clamps negative from index to 0", () => {
    const s = snapshot(["a", "b", "c"], { linesOffset: 5 });
    expect(collectLines(s, 3, 7)).toEqual(["a", "b"]);
  });

  test("clamps to index beyond lines.length", () => {
    const s = snapshot(["a", "b", "c"], { linesOffset: 5 });
    expect(collectLines(s, 6, 10)).toEqual(["b", "c"]);
  });
});

describe("findLineAbove", () => {
  test("finds matching line scanning upward", () => {
    const s = snapshot(["a", "TARGET", "b", "c", "d"]);
    expect(findLineAbove(s, 4, 5, (t) => t === "TARGET")).toBe(1);
  });

  test("returns first match from the top of the scan range", () => {
    const s = snapshot(["X", "b", "X", "d"]);
    // Scanning from index 3, should find index 2 first (closest to from)
    expect(findLineAbove(s, 3, 4, (t) => t === "X")).toBe(2);
  });

  test("returns -1 when no line matches", () => {
    const s = snapshot(["a", "b", "c"]);
    expect(findLineAbove(s, 2, 3, (t) => t === "MISSING")).toBe(-1);
  });

  test("respects maxLines limit", () => {
    const s = snapshot(["TARGET", "b", "c", "d", "e"]);
    // maxLines=2 scans indices 4 and 3 only; TARGET is at 0
    expect(findLineAbove(s, 4, 2, (t) => t === "TARGET")).toBe(-1);
  });

  test("finds match at the boundary of maxLines", () => {
    const s = snapshot(["TARGET", "b", "c"]);
    // maxLines=3 scans indices 2, 1, 0
    expect(findLineAbove(s, 2, 3, (t) => t === "TARGET")).toBe(0);
  });

  test("clamps at linesOffset boundary", () => {
    const s = snapshot(["a", "TARGET", "c", "d"], { linesOffset: 10 });
    // from=13 (abs), maxLines=100 — should clamp at offset 10
    expect(findLineAbove(s, 13, 100, (t) => t === "TARGET")).toBe(11);
  });

  test("returns -1 when from is below linesOffset", () => {
    const s = snapshot(["a", "b"], { linesOffset: 10 });
    expect(findLineAbove(s, 9, 5, (t) => t === "a")).toBe(-1);
  });

  test("works with non-zero linesOffset", () => {
    const s = snapshot(["a", "b", "TARGET", "d"], { linesOffset: 5 });
    expect(findLineAbove(s, 8, 3, (t) => t === "TARGET")).toBe(7);
  });

  test("maxLines=1 only checks the from line", () => {
    const s = snapshot(["a", "b", "TARGET"]);
    expect(findLineAbove(s, 2, 1, (t) => t === "TARGET")).toBe(2);
    expect(findLineAbove(s, 2, 1, (t) => t === "a")).toBe(-1);
  });
});

/**
 * Assert that computing the diff between `prev` and `curr`, then applying
 * it to `prev`, reconstructs `curr` (ignoring timestamp).
 */
function assertRoundtrip(prev: Snapshot, curr: Snapshot): void {
  const delta = computeSnapshotDiff(prev, curr);
  if (delta === null) {
    throw new Error("Expected non-null delta for roundtrip test");
  }
  const result = applySnapshotDiff(prev, delta, curr.timestamp);
  expect(result).toEqual(curr);
}

describe("computeSnapshotDiff", () => {
  test("identical snapshots produce empty delta", () => {
    const a = snapshot(["hello"]);
    const b = { ...a, timestamp: a.timestamp + 100 };
    const delta = computeSnapshotDiff(a, b);
    expect(delta).toEqual({});
  });

  test("single line change", () => {
    const prev = snapshot(["aaa", "bbb", "ccc"]);
    const curr = snapshot(["aaa", "XXX", "ccc"]);
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toEqual({ lines: [[1, "XXX"]] });
  });

  test("cursor change", () => {
    const prev = snapshot(["hello", "world"]);
    const curr = snapshot(["hello", "world"], {
      cursor: { x: 5, y: 3, visible: false },
    });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toEqual({ cursor: { x: 5, y: 3, visible: false } });
  });

  test("dimension change", () => {
    const prev = snapshot(["hello", "world"]);
    const curr = snapshot(["hello", "world"], { cols: 120, rows: 40 });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toEqual({ cols: 120, rows: 40 });
  });

  test("styled text line change", () => {
    const prev = snapshot([[{ t: "bold", b: true }]]);
    const curr = snapshot([[{ t: "italic", i: true }]]);
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).not.toBeNull();
    expect(delta?.lines).toEqual([[0, [{ t: "italic", i: true }]]]);
  });

  // --- Scroll detection via linesOffset ---

  test("1-line scroll (shift via linesOffset)", () => {
    const prev = snapshot(["A", "B", "C", "D"], { linesOffset: 0 });
    // After scroll: "A" dropped, "E" appended
    const curr = snapshot(["B", "C", "D", "E"], { linesOffset: 1 });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toEqual({ shift: 1, lines: [[3, "E"]] });
  });

  test("multi-line scroll", () => {
    const prev = snapshot(["A", "B", "C", "D", "E"], { linesOffset: 0 });
    const curr = snapshot(["D", "E", "", "", ""], { linesOffset: 3 });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toEqual({
      shift: 3,
      lines: [
        [2, ""],
        [3, ""],
        [4, ""],
      ],
    });
  });

  test("scroll with scrollback lines retained", () => {
    const prev = snapshot(["S0", "S1", "A", "B", "C"], {
      linesOffset: 0,
    });
    // After 1-line viewport scroll: S0 dropped, NEW appended
    const curr = snapshot(["S1", "A", "B", "C", "NEW"], {
      linesOffset: 1,
    });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toEqual({ shift: 1, lines: [[4, "NEW"]] });
  });

  test("scroll with mid-viewport line change", () => {
    const prev = snapshot(["A", "B", "C", "D"], { linesOffset: 0 });
    // Shift 1, and line at index 1 changed (B→X)
    const curr = snapshot(["B", "X", "D", "E"], { linesOffset: 1 });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toEqual({
      shift: 1,
      lines: [
        [1, "X"],
        [3, "E"],
      ],
    });
  });

  test("alternate screen change", () => {
    const prev = snapshot(["A", "B"], { alternate: false });
    const curr = snapshot(["A", "B"], { alternate: true });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toEqual({ alternate: true });
  });

  test("null linesOffset in prev is treated as reset (offset 0)", () => {
    const prev = snapshot(["A", "B"], { linesOffset: null });
    const curr = snapshot(["A", "B"], { linesOffset: 0 });
    // null means "reset" — treated as 0, so shift = 0 and lines match
    expect(computeSnapshotDiff(prev, curr)).toEqual({});
  });

  test("null linesOffset in curr returns null (keyframe required)", () => {
    const prev = snapshot(["A", "B"], { linesOffset: 0 });
    const curr = snapshot(["A", "B"], { linesOffset: null });
    expect(computeSnapshotDiff(prev, curr)).toBeNull();
  });

  test("negative linesOffset shift returns null (keyframe required)", () => {
    const prev = snapshot(["A", "B", "C", "D"], { linesOffset: 5 });
    const curr = snapshot(["A", "D"], { linesOffset: 3 });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toBeNull();
  });

  test("curr shorter than prev emits single null entry for truncation", () => {
    const prev = snapshot(["A", "B", "C", "D"], { linesOffset: 0 });
    const curr = snapshot(["A", "D"], { linesOffset: 0 });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toEqual({
      lines: [
        [1, "D"],
        [2, null],
      ],
    });
  });

  test("shift with trailing line truncation produces single null entry", () => {
    const prev = snapshot(["A", "B", "C", "D", "E"], { linesOffset: 0 });
    // After shift of 1, prev has 4 remaining lines but curr only has 2
    const curr = snapshot(["B", "C"], { linesOffset: 1 });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).toEqual({
      shift: 1,
      lines: [[2, null]],
    });
  });

  test("large shift exceeding prev lines produces valid delta", () => {
    const prev = snapshot(["A", "B", "C"], { linesOffset: 0 });
    // 10 lines trimmed, all prev lines gone, entirely new content
    const curr = snapshot(["X", "Y"], { linesOffset: 10 });
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).not.toBeNull();
    assertRoundtrip(prev, curr);
  });

  test("completely different lines produce full replacement delta", () => {
    const prev = snapshot(["A", "B", "C"]);
    const curr = snapshot(["X", "Y", "Z"]);
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).not.toBeNull();
    const result = applySnapshotDiff(
      prev,
      delta as NonNullable<typeof delta>,
      curr.timestamp,
    );
    expect(result.lines).toEqual(curr.lines);
  });

  test("lines with duplicate elements", () => {
    const prev = snapshot(["A", "B", "A", "B"]);
    const curr = snapshot(["B", "A", "B", "A"]);
    const delta = computeSnapshotDiff(prev, curr);
    expect(delta).not.toBeNull();
    const result = applySnapshotDiff(
      prev,
      delta as NonNullable<typeof delta>,
      curr.timestamp,
    );
    expect(result.lines).toEqual(curr.lines);
  });
});

describe("applySnapshotDiff", () => {
  test("empty delta produces equivalent snapshot", () => {
    const base = snapshot(["hello"]);
    const result = applySnapshotDiff(base, {}, 9999);
    expect(result).toEqual({ ...base, timestamp: 9999 });
  });

  test("roundtrip: single line change", () => {
    const prev = snapshot(["aaa", "bbb", "ccc"]);
    const curr = snapshot(["aaa", "XXX", "ccc"], {
      timestamp: prev.timestamp + 100,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: cursor change", () => {
    const prev = snapshot(["hello", "world"]);
    const curr = snapshot(["hello", "world"], {
      cursor: { x: 10, y: 5, visible: false },
      timestamp: prev.timestamp + 50,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: dimension change", () => {
    const prev = snapshot(["hello", "world"]);
    const curr = snapshot(["hello", "world"], {
      cols: 132,
      rows: 50,
      timestamp: prev.timestamp + 50,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: 1-line scroll", () => {
    const prev = snapshot(["A", "B", "C", "D"], { linesOffset: 0 });
    const curr = snapshot(["B", "C", "D", "E"], {
      linesOffset: 1,
      timestamp: prev.timestamp + 50,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: multi-line scroll", () => {
    const prev = snapshot(["A", "B", "C", "D", "E"], { linesOffset: 0 });
    const curr = snapshot(["D", "E", "", "", ""], {
      linesOffset: 3,
      timestamp: prev.timestamp + 50,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: scroll with scrollback retained", () => {
    const prev = snapshot(["S0", "S1", "A", "B", "C"], {
      linesOffset: 0,
    });
    const curr = snapshot(["S1", "A", "B", "C", "NEW"], {
      linesOffset: 1,
      timestamp: prev.timestamp + 50,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: scroll with mid-viewport change", () => {
    const prev = snapshot(["A", "B", "C", "D"], { linesOffset: 0 });
    const curr = snapshot(["B", "X", "D", "E"], {
      linesOffset: 1,
      timestamp: prev.timestamp + 50,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: alternate screen change", () => {
    const prev = snapshot(["hello", "world"], { alternate: false });
    const curr = snapshot(["hello", "world"], {
      alternate: true,
      timestamp: prev.timestamp + 50,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: complex multi-field change", () => {
    const prev = snapshot(["hello", "world"], {
      cursor: { x: 0, y: 0, visible: true },
      cols: 80,
      rows: 24,
    });
    const curr = snapshot(["HELLO", "world", "new"], {
      cursor: { x: 5, y: 2, visible: false },
      cols: 120,
      rows: 40,
      timestamp: prev.timestamp + 200,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: trailing line truncation", () => {
    const prev = snapshot(["A", "B", "C", "D"], { linesOffset: 0 });
    const curr = snapshot(["A", "D"], {
      linesOffset: 0,
      timestamp: prev.timestamp + 50,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: shift with trailing line truncation", () => {
    const prev = snapshot(["A", "B", "C", "D", "E"], { linesOffset: 0 });
    const curr = snapshot(["B", "C"], {
      linesOffset: 1,
      timestamp: prev.timestamp + 50,
    });
    assertRoundtrip(prev, curr);
  });

  test("roundtrip: lines growing with scrollback", () => {
    const prev = snapshot(["line1", "line2", "line3"]);
    const curr = snapshot(["line1", "line2", "line3", "line4", "line5"], {
      timestamp: prev.timestamp + 100,
    });
    assertRoundtrip(prev, curr);
  });
});

describe("richTextToPlainText", () => {
  test("returns plain string as-is", () => {
    expect(richTextToPlainText("hello")).toBe("hello");
  });

  test("extracts plain text from a single string segment", () => {
    expect(richTextToPlainText(["hello"])).toBe("hello");
  });

  test("concatenates multiple string segments", () => {
    expect(richTextToPlainText(["hello", " ", "world"])).toBe("hello world");
  });

  test("extracts text from StyledSegment", () => {
    const rt: RichText = [{ b: true, t: "bold text" }];
    expect(richTextToPlainText(rt)).toBe("bold text");
  });

  test("handles mixed segments", () => {
    const rt: RichText = [
      "before ",
      { fg: 1, t: "colored " },
      { fg: 1, b: true, t: "and bold" },
      " after",
    ];
    expect(richTextToPlainText(rt)).toBe("before colored and bold after");
  });

  test("returns empty string for empty RichText array", () => {
    expect(richTextToPlainText([])).toBe("");
  });

  test("returns empty string for empty string RichText", () => {
    expect(richTextToPlainText("")).toBe("");
  });
});

describe("richTextEqual", () => {
  test("equal plain strings", () => {
    expect(richTextEqual("hello", "hello")).toBe(true);
  });

  test("different plain strings", () => {
    expect(richTextEqual("hello", "world")).toBe(false);
  });

  test("plain string vs segment array with same text", () => {
    expect(richTextEqual("hello", ["hello"])).toBe(false);
  });

  test("equal segment arrays", () => {
    const a: RichText = ["hello", { t: " world", b: true }];
    const b: RichText = ["hello", { t: " world", b: true }];
    expect(richTextEqual(a, b)).toBe(true);
  });

  test("different segment arrays", () => {
    const a: RichText = [{ t: "hello", fg: 1 }];
    const b: RichText = [{ t: "hello", fg: 2 }];
    expect(richTextEqual(a, b)).toBe(false);
  });

  test("empty values", () => {
    expect(richTextEqual("", "")).toBe(true);
    expect(richTextEqual([], [])).toBe(true);
    expect(richTextEqual("", [])).toBe(false);
  });
});

describe("richTextLinesEqual", () => {
  test("equal line arrays", () => {
    expect(richTextLinesEqual(["a", "b"], ["a", "b"])).toBe(true);
  });

  test("different lengths", () => {
    expect(richTextLinesEqual(["a"], ["a", "b"])).toBe(false);
  });

  test("same length, different content", () => {
    expect(richTextLinesEqual(["a", "b"], ["a", "c"])).toBe(false);
  });

  test("empty arrays", () => {
    expect(richTextLinesEqual([], [])).toBe(true);
  });

  test("styled segment lines", () => {
    const a: RichText[] = [[{ t: "bold", b: true }], "plain"];
    const b: RichText[] = [[{ t: "bold", b: true }], "plain"];
    expect(richTextLinesEqual(a, b)).toBe(true);
  });
});
