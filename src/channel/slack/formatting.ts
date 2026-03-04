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

/**
 * Plain-text character threshold above which preformatted content is split
 * across multiple messages to avoid truncation.
 */
const SPLIT_THRESHOLD = 2000;

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
 * Callers are expected to split content via {@link splitContentByPlainTextLength}
 * before calling this function so that each chunk stays within platform limits.
 *
 * @param lines - Rich text lines to convert
 * @returns Slack rich_text leaf elements
 */
export function richTextToSlackElements(lines: RichText[]): SlackRichElement[] {
  const elements: SlackRichElement[] = [];

  for (let li = 0; li < lines.length; li++) {
    if (li > 0) {
      elements.push({ type: "text", text: "\n" });
    }

    const line = lines[li] as RichText;

    if (typeof line === "string") {
      if (line) elements.push({ type: "text", text: line });
    } else {
      for (const seg of line) {
        if (typeof seg === "string") {
          if (seg) elements.push({ type: "text", text: seg });
        } else if (seg.t) {
          const style = buildStyle(seg);
          const el: SlackTextElement = { type: "text", text: seg.t };
          if (style) el.style = style;
          elements.push(el);
        }
      }
    }
  }

  return elements;
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
 * Format message content into {@link SlackMessage} array.
 *
 * Long preformatted content (echo or multi-line) is split across multiple
 * messages when it exceeds {@link SPLIT_THRESHOLD} characters.
 *
 * @param content - Rich text lines to render
 * @param echo - Whether this message is an echo of user input
 * @returns Array of Slack message payloads (empty when content is empty)
 */
export function formatMessageContent(content: RichText[], echo: boolean): SlackMessage[] {
  const plain = content.map(richTextToPlainText).join("\n");
  if (!plain) return [];

  if (echo || content.length > 1) {
    const chunks = splitContentByPlainTextLength(content, SPLIT_THRESHOLD);
    return chunks.map((chunk) => {
      const chunkPlain = chunk.map(richTextToPlainText).join("\n");
      const elements = richTextToSlackElements(chunk);
      // rich_text_preformatted only supports SlackTextElement (not emoji)
      const textElements = elements.filter((el): el is SlackTextElement => el.type === "text");
      return {
        blocks: [richTextBlock([{ type: "rich_text_preformatted", elements: textElements }])],
        text: chunkPlain,
      };
    });
  }

  const elements = richTextToSlackElements(content);
  return [
    {
      blocks: [richTextBlock([{ type: "rich_text_section", elements }])],
      text: plain,
    },
  ];
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

/**
 * Split {@link RichText} lines into chunks where each chunk's plain-text
 * length does not exceed `threshold` characters.
 *
 * Each line is kept intact — splitting only happens between lines.
 * A single line that exceeds the threshold is placed in its own chunk.
 *
 * @param content - Rich text lines to split
 * @param threshold - Maximum plain-text character count per chunk
 * @returns Array of line groups
 */
export function splitContentByPlainTextLength(
  content: RichText[],
  threshold: number,
): RichText[][] {
  const chunks: RichText[][] = [];
  let current: RichText[] = [];
  let currentLen = 0;

  for (const line of content) {
    const lineLen = richTextToPlainText(line).length;
    // +1 accounts for the newline separator between lines
    const added = current.length === 0 ? lineLen : lineLen + 1;
    if (current.length > 0 && currentLen + added > threshold) {
      chunks.push(current);
      current = [line];
      currentLen = lineLen;
    } else {
      current.push(line);
      currentLen += added;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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
