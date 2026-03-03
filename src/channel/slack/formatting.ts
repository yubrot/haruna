/**
 * Convert scene data into Slack Block Kit structures.
 *
 * Pure functions — no I/O or Slack API calls.
 *
 * @module
 */

import { type RichText, richTextToPlainText, type StyledSegment } from "../../vt/snapshot.ts";
import type { MessageFormatter } from "../post-state.ts";

/** Slack implementation of the {@link MessageFormatter} interface. */
export const slackFormatter: MessageFormatter<SlackMessage> = {
  formatMessageContent,
  formatQuestion,
  formatPermissionRequired,
  appendContext,
};

/** Leaf text element inside a rich_text container. */
export interface SlackTextElement {
  type: "text";
  text: string;
  style?: { bold?: true; italic?: true; strike?: true; code?: true };
}

/** Leaf emoji element inside a rich_text container. */
export interface SlackEmojiElement {
  type: "emoji";
  name: string;
}

/** Union of all leaf elements that can appear inside a rich_text container. */
export type SlackRichElement = SlackTextElement | SlackEmojiElement;

/** A normal paragraph container inside a rich_text block. */
export interface SlackRichTextSection {
  type: "rich_text_section";
  elements: SlackRichElement[];
}

/** A preformatted (code block) container inside a rich_text block. */
export interface SlackRichTextPreformatted {
  type: "rich_text_preformatted";
  elements: SlackTextElement[];
}

/** Union of sub-containers inside a rich_text block. */
export type SlackRichTextContainer = SlackRichTextSection | SlackRichTextPreformatted;

/** Slack Block Kit block subset used by this module. */
export type SlackBlock =
  | { type: "rich_text"; elements: SlackRichTextContainer[] }
  | {
      type: "header";
      text: { type: "plain_text"; text: string; emoji: true };
    }
  | { type: "context"; elements: { type: "mrkdwn"; text: string }[] };

/** Result of formatting a scene event for Slack. */
export interface SlackMessage {
  /** Block Kit blocks to send via `chat.postMessage`. */
  blocks: SlackBlock[];
  /** Fallback plain-text for notifications. */
  text: string;
}

/** Maximum plain-text characters allowed in a single rich_text block. */
const RICH_TEXT_CHAR_LIMIT = 3000;

/**
 * Return a copy of `message` with a mrkdwn context block appended.
 *
 * @param message - Base message
 * @param text - mrkdwn text for the context block
 * @returns New {@link SlackMessage} with the context block added
 */
export function appendContext(message: SlackMessage, text: string): SlackMessage {
  const contextBlock: SlackBlock = {
    type: "context",
    elements: [{ type: "mrkdwn", text }],
  };
  return {
    blocks: [...message.blocks, contextBlock],
    text: message.text,
  };
}

/**
 * Convert haruna {@link RichText} lines into Slack rich_text leaf elements.
 *
 * Output is truncated at {@link RICH_TEXT_CHAR_LIMIT} characters to stay
 * within Slack's block size limit.
 *
 * @param lines - Rich text lines to convert
 * @returns Slack rich_text leaf elements
 */
export function richTextToSlackElements(lines: RichText[]): SlackRichElement[] {
  const elements: SlackRichElement[] = [];
  let charCount = 0;
  let truncated = false;

  for (let li = 0; li < lines.length; li++) {
    if (truncated) break;

    // Insert newline separator between lines
    if (li > 0) {
      if (charCount + 1 > RICH_TEXT_CHAR_LIMIT) {
        truncated = true;
        break;
      }
      elements.push({ type: "text", text: "\n" });
      charCount += 1;
    }

    const line = lines[li] as RichText;

    if (typeof line === "string") {
      const result = pushText(elements, line, charCount);
      charCount = result.charCount;
      truncated = result.truncated;
    } else {
      for (const seg of line) {
        if (truncated) break;
        if (typeof seg === "string") {
          const result = pushText(elements, seg, charCount);
          charCount = result.charCount;
          truncated = result.truncated;
        } else {
          const result = pushStyledSegment(elements, seg, charCount);
          charCount = result.charCount;
          truncated = result.truncated;
        }
      }
    }
  }

  return elements;
}

/** Push a plain text string, handling truncation. */
function pushText(
  elements: SlackRichElement[],
  text: string,
  charCount: number,
): { charCount: number; truncated: boolean } {
  const remaining = RICH_TEXT_CHAR_LIMIT - charCount;
  if (text.length > remaining) {
    const truncText = `${text.slice(0, Math.max(0, remaining - 1))}…`;
    elements.push({ type: "text", text: truncText });
    return { charCount: RICH_TEXT_CHAR_LIMIT, truncated: true };
  }
  if (text) {
    elements.push({ type: "text", text });
  }
  return { charCount: charCount + text.length, truncated: false };
}

/** Push a styled segment, mapping b/i/s to Slack style. */
function pushStyledSegment(
  elements: SlackRichElement[],
  seg: StyledSegment,
  charCount: number,
): { charCount: number; truncated: boolean } {
  const remaining = RICH_TEXT_CHAR_LIMIT - charCount;
  let text = seg.t;
  let truncated = false;

  if (text.length > remaining) {
    text = `${text.slice(0, Math.max(0, remaining - 1))}…`;
    truncated = true;
  }

  if (text) {
    const style = buildStyle(seg);
    const el: SlackTextElement = { type: "text", text };
    if (style) el.style = style;
    elements.push(el);
  }

  return {
    charCount: truncated ? RICH_TEXT_CHAR_LIMIT : charCount + seg.t.length,
    truncated,
  };
}

/** Build a Slack style object from a styled segment, or return undefined. */
function buildStyle(seg: StyledSegment): SlackTextElement["style"] | undefined {
  const bold = seg.b || undefined;
  const italic = seg.i || undefined;
  const strike = seg.s || undefined;
  if (!bold && !italic && !strike) return undefined;
  return { bold, italic, strike };
}

/** Shorthand to create a `rich_text` block. */
function richTextBlock(containers: SlackRichTextContainer[]): SlackBlock {
  return { type: "rich_text", elements: containers };
}

/**
 * Format message content into a {@link SlackMessage}.
 *
 * @param style - `"text"` for a rich_text_section, `"block"` for rich_text_preformatted
 * @param content - Rich text lines to render
 * @returns Slack message payload, or `null` when content is empty
 */
export function formatMessageContent(
  style: "text" | "block",
  content: RichText[],
): SlackMessage | null {
  const plain = content.map(richTextToPlainText).join("\n");
  if (!plain) return null;

  if (style === "block") {
    const elements = richTextToSlackElements(content);
    // rich_text_preformatted only supports SlackTextElement (not emoji)
    const textElements = elements.filter((el): el is SlackTextElement => el.type === "text");
    return {
      blocks: [richTextBlock([{ type: "rich_text_preformatted", elements: textElements }])],
      text: plain,
    };
  }

  const elements = richTextToSlackElements(content);
  return {
    blocks: [richTextBlock([{ type: "rich_text_section", elements }])],
    text: plain,
  };
}

/**
 * Format a question event into a {@link SlackMessage}.
 *
 * @param event - Question payload
 * @returns Slack message with question body and option list
 */
export function formatQuestion(event: {
  question: string;
  options: { label: string; description?: string }[];
}): SlackMessage {
  const blocks: SlackBlock[] = [];

  const bodyElements: SlackTextElement[] = [{ type: "text", text: event.question }];
  pushOptionElements(bodyElements, event.options);

  blocks.push(richTextBlock([{ type: "rich_text_preformatted", elements: bodyElements }]));

  return { blocks, text: event.question };
}

/**
 * Format a permission-required event into a {@link SlackMessage}.
 *
 * @param event - Permission-required payload
 * @returns Slack message with a warning header, optional description, and options
 */
export function formatPermissionRequired(event: {
  command: string;
  description?: string;
  options: { label: string; description?: string }[];
}): SlackMessage {
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `:warning: ${event.command}`,
      emoji: true,
    },
  });

  const bodyElements: SlackTextElement[] = [];

  if (event.description) {
    bodyElements.push({ type: "text", text: event.description });
  }

  pushOptionElements(bodyElements, event.options);

  if (bodyElements.length > 0) {
    blocks.push(richTextBlock([{ type: "rich_text_preformatted", elements: bodyElements }]));
  }

  return { blocks, text: `Permission required: ${event.command}` };
}

/** Append numbered options to an element list with leading separator. */
function pushOptionElements(
  elements: SlackTextElement[],
  options: { label: string; description?: string }[],
): void {
  if (options.length === 0) return;
  if (elements.length > 0) {
    elements.push({ type: "text", text: "\n\n" });
  }
  for (let i = 0; i < options.length; i++) {
    if (i > 0) elements.push({ type: "text", text: "\n" });
    const opt = options[i];
    if (!opt) continue;
    elements.push({ type: "text", text: `${i + 1}. `, style: { bold: true } });
    elements.push({ type: "text", text: opt.label, style: { bold: true } });
    if (opt.description) {
      elements.push({ type: "text", text: ` — ${opt.description}` });
    }
  }
}
