import { describe, expect, test } from "bun:test";
import {
  appendContext,
  formatMessageContent,
  formatPermissionRequired,
  formatQuestion,
  richTextToSlackElements,
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

  test("truncates text exceeding character limit", () => {
    const longText = "x".repeat(4000);
    const result = richTextToSlackElements([longText]);
    expect(result).toHaveLength(1);
    const el = result[0] as { type: "text"; text: string };
    expect(el.text.length).toBeLessThanOrEqual(3000);
    expect(el.text.endsWith("…")).toBe(true);
  });

  test("skips empty string segments", () => {
    const result = richTextToSlackElements([["", "hello"]]);
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("formatMessageContent", () => {
  test("formats single-line text as rich_text section", () => {
    const result = formatMessageContent("text", ["hello world"]);
    expect(result).toEqual({
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
    });
  });

  test("formats multi-line text as rich_text section", () => {
    const result = formatMessageContent("text", ["line 1", "line 2"]);
    expect(result).toMatchObject({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
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

  test("formats block style as rich_text preformatted", () => {
    const result = formatMessageContent("block", ["code here"]);
    expect(result).toMatchObject({
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

  test("preserves rich text segment styles", () => {
    const result = formatMessageContent("text", [[{ t: "bold", b: true }, " plain"]]);
    expect(result).toMatchObject({
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

  test("returns null for empty content", () => {
    expect(formatMessageContent("text", [""])).toBeNull();
  });

  test("truncates text exceeding character limit", () => {
    const longText = `${"x".repeat(4000)}\nsecond line`;
    const result = formatMessageContent("text", [longText]);
    const block = result?.blocks[0];
    expect(block).toMatchObject({ type: "rich_text" });
    if (block?.type === "rich_text") {
      const section = block.elements[0];
      expect(section).toBeDefined();
      if (section) {
        const totalChars = section.elements.reduce(
          (sum, el) => sum + ("text" in el ? el.text.length : 0),
          0,
        );
        expect(totalChars).toBeLessThanOrEqual(3000);
      }
    }
  });

  test("truncates block style message exceeding character limit", () => {
    const longText = "x".repeat(4000);
    const result = formatMessageContent("block", [longText]);
    const block = result?.blocks[0];
    expect(block).toMatchObject({ type: "rich_text" });
    if (block?.type === "rich_text") {
      const pre = block.elements[0];
      expect(pre).toBeDefined();
      if (pre) {
        const totalChars = pre.elements.reduce(
          (sum, el) => sum + ("text" in el ? el.text.length : 0),
          0,
        );
        expect(totalChars).toBeLessThanOrEqual(3000);
      }
    }
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
