import { describe, expect, test } from "bun:test";
import {
  appendContext,
  formatMessageContent,
  formatPermissionRequired,
  formatQuestion,
} from "./formatting.ts";

describe("formatMessageContent", () => {
  test("formats single-line non-echo content as Markdown text", () => {
    const result = formatMessageContent(["hello world"], false);
    expect(result).toBe("hello world");
  });

  test("formats multi-line content as code block", () => {
    const result = formatMessageContent(["line 1", "line 2"], false);
    expect(result).toBe("```\nline 1\nline 2\n```");
  });

  test("preserves rich text styles for single-line non-echo content", () => {
    const result = formatMessageContent(
      [[{ t: "bold", b: true }, " and ", { t: "italic", i: true }]],
      false,
    );
    expect(result).toBe("**bold** and *italic*");
  });

  test("formats echo content as code block", () => {
    const result = formatMessageContent(["code here"], true);
    expect(result).toBe("```\ncode here\n```");
  });

  test("formats multi-line echo content as code block", () => {
    const result = formatMessageContent(["line 1", "line 2"], true);
    expect(result).toBe("```\nline 1\nline 2\n```");
  });

  test("echo strips rich text styles in code block", () => {
    const result = formatMessageContent([[{ t: "bold", b: true }, " plain"]], true);
    expect(result).toBe("```\nbold plain\n```");
  });

  test("returns null for empty content", () => {
    expect(formatMessageContent([""], false)).toBeNull();
  });

  test("returns null for empty echo content", () => {
    expect(formatMessageContent([""], true)).toBeNull();
  });

  test("truncates text exceeding 2000 character limit", () => {
    const longText = "x".repeat(3000);
    const result = formatMessageContent([longText], false);
    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(2000);
    expect(result?.endsWith("…")).toBe(true);
  });

  test("truncates block exceeding 2000 character limit with closing fence preserved", () => {
    const longText = "x".repeat(3000);
    const result = formatMessageContent([longText], true);
    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(2000);
    expect(result?.endsWith("\n```")).toBe(true);
    expect(result?.startsWith("```\n")).toBe(true);
  });

  test("escapes triple backticks inside code blocks with zero-width space", () => {
    const result = formatMessageContent(["before ``` after"], true);
    expect(result).toBe("```\nbefore `\u200B`` after\n```");
  });

  test("escapes multiple triple backticks inside code blocks", () => {
    const result = formatMessageContent(["a ``` b ``` c"], true);
    expect(result).toBe("```\na `\u200B`` b `\u200B`` c\n```");
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
