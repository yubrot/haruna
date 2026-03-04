import { describe, expect, test } from "bun:test";
import {
  appendContext,
  formatMessageContent,
  formatPermissionRequired,
  formatQuestion,
  splitLines,
} from "./formatting.ts";

describe("formatMessageContent", () => {
  test("formats single-line non-echo content as Markdown text", () => {
    const result = formatMessageContent(["hello world"], false);
    expect(result).toEqual(["hello world"]);
  });

  test("formats multi-line content as code block", () => {
    const result = formatMessageContent(["line 1", "line 2"], false);
    expect(result).toEqual(["```\nline 1\nline 2\n```"]);
  });

  test("preserves rich text styles for single-line non-echo content", () => {
    const result = formatMessageContent(
      [[{ t: "bold", b: true }, " and ", { t: "italic", i: true }]],
      false,
    );
    expect(result).toEqual(["**bold** and *italic*"]);
  });

  test("formats echo content as code block", () => {
    const result = formatMessageContent(["code here"], true);
    expect(result).toEqual(["```\ncode here\n```"]);
  });

  test("formats multi-line echo content as code block", () => {
    const result = formatMessageContent(["line 1", "line 2"], true);
    expect(result).toEqual(["```\nline 1\nline 2\n```"]);
  });

  test("echo strips rich text styles in code block", () => {
    const result = formatMessageContent([[{ t: "bold", b: true }, " plain"]], true);
    expect(result).toEqual(["```\nbold plain\n```"]);
  });

  test("returns empty array for empty content", () => {
    expect(formatMessageContent([""], false)).toEqual([]);
  });

  test("returns empty array for empty echo content", () => {
    expect(formatMessageContent([""], true)).toEqual([]);
  });

  test("passes through long single-line content without truncation", () => {
    const longText = "x".repeat(3000);
    const result = formatMessageContent([longText], false);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(longText);
  });

  test("escapes triple backticks inside code blocks with zero-width space", () => {
    const result = formatMessageContent(["before ``` after"], true);
    expect(result).toEqual(["```\nbefore `\u200B`` after\n```"]);
  });

  test("escapes multiple triple backticks inside code blocks", () => {
    const result = formatMessageContent(["a ``` b ``` c"], true);
    expect(result).toEqual(["```\na `\u200B`` b `\u200B`` c\n```"]);
  });

  test("splits long block content into multiple messages", () => {
    // Create content that exceeds the 1500-char split threshold
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(30)}`);
    const result = formatMessageContent(lines, false);
    expect(result.length).toBeGreaterThan(1);
    for (const msg of result) {
      expect(msg.startsWith("```\n")).toBe(true);
      expect(msg.endsWith("\n```")).toBe(true);
    }
  });

  test("splits long echo content into multiple messages", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `echo ${i}: ${"y".repeat(30)}`);
    const result = formatMessageContent(lines, true);
    expect(result.length).toBeGreaterThan(1);
    for (const msg of result) {
      expect(msg.startsWith("```\n")).toBe(true);
      expect(msg.endsWith("\n```")).toBe(true);
    }
  });

  test("does not split single-line content (non-block)", () => {
    const result = formatMessageContent(["short message"], false);
    expect(result).toHaveLength(1);
  });

  test("does not split block content under threshold", () => {
    const result = formatMessageContent(["line 1", "line 2", "line 3"], false);
    expect(result).toHaveLength(1);
  });
});

describe("splitLines", () => {
  test("keeps all lines in one chunk when under threshold", () => {
    const result = splitLines(["a", "b", "c"], 100);
    expect(result).toEqual([["a", "b", "c"]]);
  });

  test("splits lines into multiple chunks when exceeding threshold", () => {
    const result = splitLines(["aaaa", "bbbb", "cccc", "dddd"], 9);
    // "aaaa\nbbbb" = 9 chars → fits
    // "cccc\ndddd" = 9 chars → fits
    expect(result).toEqual([
      ["aaaa", "bbbb"],
      ["cccc", "dddd"],
    ]);
  });

  test("places oversized single line in its own chunk", () => {
    const result = splitLines(["short", "x".repeat(200), "short2"], 50);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(["short"]);
    expect(result[1]).toEqual(["x".repeat(200)]);
    expect(result[2]).toEqual(["short2"]);
  });

  test("handles empty input", () => {
    const result = splitLines([], 100);
    expect(result).toEqual([]);
  });

  test("handles single line", () => {
    const result = splitLines(["only"], 100);
    expect(result).toEqual([["only"]]);
  });
});

describe("formatQuestion", () => {
  test("formats with numbered options", () => {
    const result = formatQuestion({
      question: "Which color?",
      options: [
        { label: "Red", description: "Warm" },
        { label: "Blue", description: "Cool" },
      ],
    });
    expect(result).toBe("```\nWhich color?\n```\n\n1. **Red** — Warm\n2. **Blue** — Cool");
  });

  test("formats options without descriptions", () => {
    const result = formatQuestion({
      question: "Continue?",
      options: [{ label: "Yes" }, { label: "No" }],
    });
    expect(result).toBe("```\nContinue?\n```\n\n1. **Yes**\n2. **No**");
  });

  test("formats with empty options", () => {
    const result = formatQuestion({
      question: "Updated?",
      options: [],
    });
    expect(result).toBe("```\nUpdated?\n```");
  });
});

describe("formatPermissionRequired", () => {
  test("formats with warning and options", () => {
    const result = formatPermissionRequired({
      command: "rm -rf /",
      description: "Dangerous operation",
      options: [{ label: "Allow" }, { label: "Deny" }],
    });
    expect(result).toBe("⚠️ **rm -rf /**\nDangerous operation\n\n1. **Allow**\n2. **Deny**");
  });

  test("formats without description", () => {
    const result = formatPermissionRequired({
      command: "git push",
      options: [{ label: "Allow" }, { label: "Deny" }],
    });
    expect(result).toBe("⚠️ **git push**\n\n1. **Allow**\n2. **Deny**");
  });

  test("formats without options", () => {
    const result = formatPermissionRequired({
      command: "test",
      options: [],
    });
    expect(result).toBe("⚠️ **test**");
  });
});

describe("appendContext", () => {
  test("appends context as quote block", () => {
    const result = appendContext("hello world", "Thinking...");
    expect(result).toBe("hello world\n> Thinking...");
  });
});
