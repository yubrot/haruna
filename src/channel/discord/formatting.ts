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

/** Maximum characters allowed in a single Discord message. */
const DISCORD_CHAR_LIMIT = 2000;

/** Discord implementation of the {@link MessageFormatter} interface. */
export const discordFormatter: MessageFormatter<DiscordMessage> = {
  formatMessageContent,
  formatQuestion,
  formatPermissionRequired,
  appendContext,
};

/**
 * Format message content into a Discord Markdown string.
 *
 * @param style - `"text"` for Markdown-styled text, `"block"` for a code block
 * @param content - Rich text lines to render
 * @returns Discord message string, or `null` when content is empty
 */
export function formatMessageContent(
  style: "text" | "block",
  content: RichText[],
): DiscordMessage | null {
  if (style === "block") {
    const plain = content.map(richTextToPlainText).join("\n");
    if (!plain) return null;
    return codeBlock(plain);
  }

  const markdown = content.map(richTextToMarkdown).join("\n");
  if (!markdown) return null;
  return truncate(markdown);
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
  return truncate(text);
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
  return truncate(text);
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

/** Wrap text in a Discord code block, truncating inner content to preserve closing fence. */
function codeBlock(text: string): string {
  const overhead = 8; // "```\n" (4) + "\n```" (4)
  const innerLimit = DISCORD_CHAR_LIMIT - overhead;
  let inner = text.length > innerLimit ? `${text.slice(0, innerLimit - 1)}…` : text;
  // Break triple-backtick sequences with a zero-width space to prevent closing the code block
  inner = inner.replaceAll("```", "`\u200B``");
  return `\`\`\`\n${inner}\n\`\`\``;
}

/** Truncate a message to fit within Discord's character limit. */
function truncate(text: string): string {
  if (text.length <= DISCORD_CHAR_LIMIT) return text;
  return `${text.slice(0, DISCORD_CHAR_LIMIT - 1)}…`;
}
