import { describe, expect, test } from "bun:test";
import {
  appendContext,
  formatMessageContent,
  formatPermissionRequired,
  formatQuestion,
  richTextToSlackElements,
  splitContentByPlainTextLength,
} from "./formatting.ts";

describe("richTextToSlackElements", () => {
  test("converts plain string lines with newline separators", () => {
    const result = richTextToSlackElements(["line 1", "line 2"]);
    expect(result).toEqual([
      { type: "text", text: "line 1" },
      { type: "text", text: "\n" },
      { type: "text", text: "line 2" },
    ]);
  });

  test("maps bold/italic/strikethrough from StyledSegment", () => {
    const result = richTextToSlackElements([
      [{ t: "bold", b: true }, " ", { t: "italic", i: true }, { t: "strike", s: true }],
    ]);
    expect(result).toEqual([
      { type: "text", text: "bold", style: { bold: true } },
      { type: "text", text: " " },
      { type: "text", text: "italic", style: { italic: true } },
      { type: "text", text: "strike", style: { strike: true } },
    ]);
  });

  test("maps combined styles", () => {
    const result = richTextToSlackElements([[{ t: "combo", b: true, i: true, s: true }]]);
    expect(result).toEqual([
      {
        type: "text",
        text: "combo",
        style: { bold: true, italic: true, strike: true },
      },
    ]);
  });

  test("ignores unsupported styles (dim, underline, inverse, overline)", () => {
    const result = richTextToSlackElements([[{ t: "styled", d: true, u: true, v: true, o: true }]]);
    expect(result).toEqual([{ type: "text", text: "styled" }]);
  });

  test("passes through long text without truncation", () => {
    const longText = "x".repeat(4000);
    const result = richTextToSlackElements([longText]);
    expect(result).toHaveLength(1);
    const el = result[0] as { type: "text"; text: string };
    expect(el.text.length).toBe(4000);
  });

  test("skips empty string segments", () => {
    const result = richTextToSlackElements([["", "hello"]]);
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("formatMessageContent", () => {
  test("formats single-line non-echo content as rich_text section", () => {
    const result = formatMessageContent(["hello world"], false);
    expect(result).toEqual([
      {
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "hello world" }],
              },
            ],
          },
        ],
        text: "hello world",
      },
    ]);
  });

  test("formats multi-line content as rich_text preformatted", () => {
    const result = formatMessageContent(["line 1", "line 2"], false);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_preformatted",
              elements: [
                { type: "text", text: "line 1" },
                { type: "text", text: "\n" },
                { type: "text", text: "line 2" },
              ],
            },
          ],
        },
      ],
      text: "line 1\nline 2",
    });
  });

  test("formats echo content as rich_text preformatted", () => {
    const result = formatMessageContent(["code here"], true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_preformatted",
              elements: [{ type: "text", text: "code here" }],
            },
          ],
        },
      ],
    });
  });

  test("preserves rich text segment styles for single-line non-echo content", () => {
    const result = formatMessageContent([[{ t: "bold", b: true }, " plain"]], false);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "bold", style: { bold: true } },
                { type: "text", text: " plain" },
              ],
            },
          ],
        },
      ],
      text: "bold plain",
    });
  });

  test("returns empty array for empty content", () => {
    expect(formatMessageContent([""], false)).toEqual([]);
  });

  test("passes through long single-line content without truncation", () => {
    const longText = "x".repeat(4000);
    const result = formatMessageContent([longText], false);
    expect(result).toHaveLength(1);
    const block = result[0]?.blocks[0];
    if (block?.type === "rich_text") {
      const section = block.elements[0];
      if (section) {
        const totalChars = section.elements.reduce(
          (sum, el) => sum + ("text" in el ? el.text.length : 0),
          0,
        );
        expect(totalChars).toBe(4000);
      }
    }
  });

  test("splits long preformatted content into multiple messages", () => {
    // Create content that exceeds the 2500-char split threshold
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: ${"x".repeat(30)}`);
    const result = formatMessageContent(lines, false);
    expect(result.length).toBeGreaterThan(1);
    for (const msg of result) {
      expect(msg.blocks[0]).toMatchObject({ type: "rich_text" });
    }
  });

  test("splits long echo content into multiple messages", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `echo ${i}: ${"y".repeat(30)}`);
    const result = formatMessageContent(lines, true);
    expect(result.length).toBeGreaterThan(1);
    for (const msg of result) {
      const block = msg.blocks[0];
      if (block?.type === "rich_text") {
        expect(block.elements[0]?.type).toBe("rich_text_preformatted");
      }
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

describe("splitContentByPlainTextLength", () => {
  test("keeps all lines in one chunk when under threshold", () => {
    const result = splitContentByPlainTextLength(["a", "b", "c"], 100);
    expect(result).toEqual([["a", "b", "c"]]);
  });

  test("splits lines into multiple chunks when exceeding threshold", () => {
    const result = splitContentByPlainTextLength(["aaaa", "bbbb", "cccc", "dddd"], 9);
    expect(result).toEqual([
      ["aaaa", "bbbb"],
      ["cccc", "dddd"],
    ]);
  });

  test("places oversized single line in its own chunk", () => {
    const result = splitContentByPlainTextLength(["short", "x".repeat(200), "short2"], 50);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(["short"]);
    expect(result[1]).toEqual(["x".repeat(200)]);
    expect(result[2]).toEqual(["short2"]);
  });

  test("handles empty input", () => {
    const result = splitContentByPlainTextLength([], 100);
    expect(result).toEqual([]);
  });

  test("handles single line", () => {
    const result = splitContentByPlainTextLength(["only"], 100);
    expect(result).toEqual([["only"]]);
  });

  test("measures plain text length for styled content", () => {
    // Styled segment "bold" has 4 chars of plain text
    const styledLine = [{ t: "bold", b: true as const }, " text"];
    const result = splitContentByPlainTextLength(
      [styledLine, styledLine, styledLine, styledLine],
      19,
    );
    // "bold text" = 9 chars, "bold text\nbold text" = 19 chars → fits in threshold 19
    expect(result).toEqual([
      [styledLine, styledLine],
      [styledLine, styledLine],
    ]);
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
    expect(result).toMatchObject({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_preformatted",
              elements: [
                { type: "text", text: "Which color?" },
                { type: "text", text: "\n\n" },
                { type: "text", text: "1. ", style: { bold: true } },
                { type: "text", text: "Red", style: { bold: true } },
                { type: "text", text: " — Warm" },
                { type: "text", text: "\n" },
                { type: "text", text: "2. ", style: { bold: true } },
                { type: "text", text: "Blue", style: { bold: true } },
                { type: "text", text: " — Cool" },
              ],
            },
          ],
        },
      ],
      text: "Which color?",
    });
  });

  test("formats options without descriptions", () => {
    const result = formatQuestion({
      question: "Continue?",
      options: [{ label: "Yes" }, { label: "No" }],
    });
    expect(result).toMatchObject({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_preformatted",
              elements: [
                { type: "text", text: "Continue?" },
                { type: "text", text: "\n\n" },
                { type: "text", text: "1. ", style: { bold: true } },
                { type: "text", text: "Yes", style: { bold: true } },
                { type: "text", text: "\n" },
                { type: "text", text: "2. ", style: { bold: true } },
                { type: "text", text: "No", style: { bold: true } },
              ],
            },
          ],
        },
      ],
      text: "Continue?",
    });
  });

  test("formats with empty options", () => {
    const result = formatQuestion({
      question: "updated?",
      options: [],
    });
    expect(result).toMatchObject({
      blocks: [{ type: "rich_text" }],
      text: "updated?",
    });
    expect(result.blocks).toHaveLength(1);
  });
});

describe("formatPermissionRequired", () => {
  test("formats with warning header and numbered options", () => {
    const result = formatPermissionRequired({
      command: "rm -rf /",
      description: "Dangerous operation",
      options: [{ label: "Allow" }, { label: "Deny" }],
    });
    expect(result).toMatchObject({
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: ":warning: rm -rf /",
            emoji: true,
          },
        },
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_preformatted",
              elements: [
                { type: "text", text: "Dangerous operation" },
                { type: "text", text: "\n\n" },
                { type: "text", text: "1. ", style: { bold: true } },
                { type: "text", text: "Allow", style: { bold: true } },
                { type: "text", text: "\n" },
                { type: "text", text: "2. ", style: { bold: true } },
                { type: "text", text: "Deny", style: { bold: true } },
              ],
            },
          ],
        },
      ],
      text: "Permission required: rm -rf /",
    });
  });
});

describe("appendContext", () => {
  test("appends context block to message with blocks", () => {
    const result = appendContext(
      {
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "hello\nworld" }],
              },
            ],
          },
        ],
        text: "hello\nworld",
      },
      "Thinking...",
    );
    expect(result).toMatchObject({
      blocks: [
        { type: "rich_text" },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "Thinking..." }],
        },
      ],
      text: "hello\nworld",
    });
  });

  test("does not mutate the original message", () => {
    const original = {
      blocks: [
        {
          type: "rich_text" as const,
          elements: [
            {
              type: "rich_text_section" as const,
              elements: [{ type: "text" as const, text: "original" }],
            },
          ],
        },
      ],
      text: "original",
    };
    appendContext(original, "Thinking...");
    expect(original.blocks).toHaveLength(1);
  });
});
