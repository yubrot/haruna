/**
 * Convert scene data into Discord Markdown messages.
 *
 * Pure functions — no I/O or Discord API calls.
 *
 * @module
 */

import { type RichText, richTextToMarkdown, richTextToPlainText } from "../../vt/snapshot.ts";
import type { MessageFormatter } from "../post-state.ts";

/** Discord message is a plain Markdown string. */
export type DiscordMessage = string;

/**
 * Plain-text character threshold above which block content is split
 * across multiple messages to avoid truncation.
 */
const SPLIT_THRESHOLD = 1000;

/** Discord implementation of the {@link MessageFormatter} interface. */
export const discordFormatter: MessageFormatter<DiscordMessage> = {
  formatMessageContent,
  formatQuestion,
  formatPermissionRequired,
  appendContext,
};

/**
 * Format message content into Discord Markdown strings.
 *
 * Long block content (echo or multi-line) is split across multiple
 * messages when it exceeds {@link SPLIT_THRESHOLD} characters.
 *
 * @param content - Rich text lines to render
 * @param echo - Whether this message is an echo of user input
 * @returns Array of Discord message strings (empty when content is empty)
 */
export function formatMessageContent(content: RichText[], echo: boolean): DiscordMessage[] {
  if (echo || content.length > 1) {
    const lines = content.map(richTextToPlainText);
    const plain = lines.join("\n");
    if (!plain) return [];
    const chunks = splitLines(lines, SPLIT_THRESHOLD);
    return chunks.map((chunk) => codeBlock(chunk.join("\n")));
  }

  const markdown = content.map(richTextToMarkdown).join("\n");
  if (!markdown) return [];
  return [markdown];
}

/**
 * Format a question event into a Discord Markdown string.
 *
 * @param event - Question payload
 * @returns Discord message with question body and numbered options
 */
export function formatQuestion(event: {
  question: string;
  options: { label: string; description?: string }[];
}): DiscordMessage {
  let text = codeBlock(event.question);
  text += formatOptions(event.options);
  return text;
}

/**
 * Format a permission-required event into a Discord Markdown string.
 *
 * @param event - Permission-required payload
 * @returns Discord message with warning and options
 */
export function formatPermissionRequired(event: {
  command: string;
  description?: string;
  options: { label: string; description?: string }[];
}): DiscordMessage {
  let text = `⚠️ **${event.command}**`;
  if (event.description) {
    text += `\n${event.description}`;
  }
  text += formatOptions(event.options);
  return text;
}

/**
 * Return a copy of the message with a context indicator appended as a quote block.
 *
 * @param message - Base message
 * @param text - Context text (e.g. indicator status)
 * @returns New message with quoted context added
 */
export function appendContext(message: DiscordMessage, text: string): DiscordMessage {
  return `${message}\n> ${text}`;
}

/**
 * Split lines into chunks where each chunk's joined plain text
 * does not exceed `threshold` characters.
 *
 * Each line is kept intact — splitting only happens between lines.
 * A single line that exceeds the threshold is placed in its own chunk.
 *
 * @param lines - Plain text lines to split
 * @param threshold - Maximum character count per chunk
 * @returns Array of line groups
 */
export function splitLines(lines: string[], threshold: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    const lineLen = line.length;
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

/** Format numbered options as a string suffix. */
function formatOptions(options: { label: string; description?: string }[]): string {
  if (options.length === 0) return "";
  let text = "\n";
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (!opt) continue;
    text += `\n${i + 1}. **${opt.label}**`;
    if (opt.description) {
      text += ` — ${opt.description}`;
    }
  }
  return text;
}

/** Wrap text in a Discord code block. */
function codeBlock(text: string): string {
  // Break triple-backtick sequences with a zero-width space to prevent closing the code block
  const inner = text.replaceAll("```", "`\u200B``");
  return `\`\`\`\n${inner}\n\`\`\``;
}
