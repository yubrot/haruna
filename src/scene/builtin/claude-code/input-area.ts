/**
 * Input area parsing for the Claude Code scene.
 *
 * Recognizes four input layouts at the bottom of the screen:
 * free (❯ prompt), question (numbered options), permission prompt,
 * and plan review (ExitPlanMode confirmation).
 *
 * Detection uses visual structural elements (────, ╌╌╌╌, ❯, n.) as
 * primary signals with a linear top-down fallback chain.
 *
 * @module
 */

import { collectPlainLines, findLineAbove, type Snapshot } from "../../../vt/snapshot.ts";

/** Separator line pattern (series of ─ characters). */
const SEPARATOR = /^─{8,}$/;

/** Content separator pattern (series of ╌ characters, used in plan and file preview). */
const CONTENT_SEPARATOR = /^╌{8,}$/;

/** Input prompt pattern (❯ at the start of a line). */
const INPUT_PROMPT = /^❯\s?(.*)/;

/** Numbered option line pattern. */
const OPTION = /^\s*([❯ ])\s*(?:\d+)\.\s+(.*)/;

/**
 * Short permission-style label — 1-2 capitalized words without punctuation.
 * Matches tool names like "Create file", "Bash command", "Fetch", "Read".
 * Does not match plan intro text like "Ready to code?", "Here is Claude's plan:".
 */
const PERMISSION_LABEL = /^\s*[A-Z]\w+(\s+\w+)?\s*$/;

/** Permission confirmation question that appears before options in permission prompts. */
const PERMISSION_QUESTION = /^\s*Do you want to proceed\?/;

/**
 * Result of scanning for the input area at the bottom of the screen.
 *
 * Discriminated on `body.kind`:
 * - `"free"` — standard ❯ prompt with editable input text
 * - `"question"` — numbered-option question UI replacing the input area
 * - `"permission"` — permission prompt with command, description, and options
 * - `"plan_review"` — ExitPlanMode confirmation with plan content and options
 */
export interface InputArea {
  /** Absolute index of the upper separator. */
  upperSep: number;
  /** Body of the input area. */
  body: InputFree | InputQuestion | InputPermission | InputPlanReview;
}

export interface InputFree {
  kind: "free";
  /** Raw text of the ❯ prompt (may be empty). */
  inputText: string;
}

export interface InputQuestion extends Options {
  kind: "question";
  /** Question text (includes tab navigation line when present). */
  question: string;
}

/** Parsed permission input area with command, description, and options. */
export interface InputPermission extends Options {
  kind: "permission";
  /** Command or tool name requesting permission. */
  command: string;
  /** Human-readable description, if present. */
  description?: string;
}

/** Parsed plan review input area (ExitPlanMode confirmation UI). */
export interface InputPlanReview extends Options {
  kind: "plan_review";
  /** Question text displayed above the options. */
  question: string;
  /** Plan content lines between the two ╌╌╌╌ separators. */
  planContent: string[];
}

interface Options {
  /** Available options. */
  options: { label: string; description?: string }[];
  /** 0-based index of the selected option, if any. */
  selected?: number;
}

/**
 * Scan a snapshot from the bottom upward for the Claude Code input area.
 *
 * Locates the nearest `────` separator from the bottom, then checks for a
 * second `────` above it to classify as bracketed (two separators) or
 * open (single separator).
 *
 * @returns The detected input area, or `null` if the pattern is not found
 */
export function findInputArea(snapshot: Snapshot): InputArea | null {
  const offset = snapshot.linesOffset ?? 0;
  const end = offset + snapshot.lines.length;
  if (snapshot.lines.length < 4) return null;

  // Phase 1: Locate the input area boundary
  // - Find ──── from bottom within 20 lines
  // - If not found, check for ╌╌╌╌ or "Do you want to proceed?" near bottom
  //   (these indicate plan content or long permission prompts that push ──── far up)
  // - If ──── never found → null
  let sep = findLineAbove(snapshot, end - 1, 20, (text) => SEPARATOR.test(text));
  if (sep < 0) {
    const widen =
      findLineAbove(snapshot, end - 1, 15, (text) => CONTENT_SEPARATOR.test(text)) >= 0 ||
      findLineAbove(snapshot, end - 1, 15, (text) => PERMISSION_QUESTION.test(text)) >= 0;
    if (widen) {
      sep = findLineAbove(snapshot, end - 1, 500, (text) => SEPARATOR.test(text));
    }
  }
  if (sep < 0) return null;

  // Phase 2: Classify layout
  // Two ──── separators → try bracketed layout first, fall back to open
  // One ──── separator  → open layout (options below it)
  const moreSep = findLineAbove(snapshot, sep - 1, 20, (text) => SEPARATOR.test(text));
  if (moreSep >= 0) {
    return tryBracketedLayout(snapshot, sep, moreSep) ?? tryOpenLayout(snapshot, sep, end);
  }
  return tryOpenLayout(snapshot, sep, end);
}

/**
 * Try to detect a bracketed layout where the given separator is the lower boundary.
 *
 * Splits lines into pre-option and option sections, then delegates to
 * tryQuestion (with options) or tryFree (without).
 */
function tryBracketedLayout(
  snapshot: Snapshot,
  lowerSep: number,
  upperSep: number,
): InputArea | null {
  const lines = collectPlainLines(snapshot, upperSep + 1, lowerSep);
  const optionsIdx = lines.findIndex((line) => OPTION.test(line));

  if (optionsIdx >= 0) {
    const opts = parseOptions(lines.slice(optionsIdx));
    if (opts.options.length === 0) return null;

    const preOptionLines = lines.slice(0, optionsIdx);
    return tryQuestion(upperSep, preOptionLines, opts);
  }
  return tryFree(upperSep, lines);
}

/**
 * Try to detect an open layout where options are below the ──── separator.
 *
 * Collects all lines below the separator, locates the option block from the
 * bottom (including description lines), and splits into pre-option and option
 * sections, then delegates via tryPlan → tryPermission → tryQuestion.
 */
function tryOpenLayout(snapshot: Snapshot, upperSep: number, end: number): InputArea | null {
  const lines = collectPlainLines(snapshot, upperSep + 1, end);

  // Find the last OPTION line (skip trailing blanks and non-option lines)
  let optionsBottom = lines.length - 1;
  while (optionsBottom >= 0 && !lines[optionsBottom]?.trim()) optionsBottom--;
  while (optionsBottom >= 0 && !OPTION.test(lines[optionsBottom] as string)) optionsBottom--;
  if (optionsBottom < 0) return null;

  // Scan upward to include OPTION lines and their description lines (4+ space indented)
  let optionsTop = optionsBottom;
  while (optionsTop > 0) {
    const prev = lines[optionsTop - 1] as string;
    if (OPTION.test(prev) || /^\s{4,}/.test(prev)) optionsTop--;
    else break;
  }

  const opts = parseOptions(lines.slice(optionsTop, optionsBottom + 1));
  if (opts.options.length === 0) return null;

  const preOptionLines = lines.slice(0, optionsTop);
  return (
    tryPlan(upperSep, preOptionLines, opts) ??
    tryPermission(upperSep, preOptionLines, opts) ??
    tryQuestion(upperSep, preOptionLines, opts)
  );
}

/**
 * Try to detect a free input layout with ❯ prompt.
 */
function tryFree(upperSep: number, lines: string[]): InputArea | null {
  const promptIdx = lines.findLastIndex((line) => INPUT_PROMPT.test(line));
  if (promptIdx < 0) return null;
  const firstLine = (lines[promptIdx] as string).match(INPUT_PROMPT)?.[1] ?? "";
  const rest = lines.slice(promptIdx + 1).filter((l) => l.trim());
  const inputText = [firstLine, ...rest].join("\n").trimEnd();
  return { upperSep, body: { kind: "free", inputText } };
}

/**
 * Try to detect a question layout (fallback for any open layout with options).
 */
function tryQuestion(upperSep: number, lines: string[], opts: Options): InputArea | null {
  const question = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  return { upperSep, body: { kind: "question", question, ...opts } };
}

/**
 * Try to detect a permission layout.
 *
 * First non-blank line is the command. Remaining lines form the description.
 * ╌╌╌╌ lines (file preview separators) are skipped.
 */
function tryPermission(upperSep: number, lines: string[], opts: Options): InputArea | null {
  const meaningful = lines.map((l) => l.trim()).filter((l) => l && !CONTENT_SEPARATOR.test(l));
  const command = meaningful[0];
  if (!command || !PERMISSION_LABEL.test(command)) return null;

  const descLines = meaningful.slice(1);
  const description = descLines.length > 0 ? descLines.join("\n") : undefined;

  return { upperSep, body: { kind: "permission", command, description, ...opts } };
}

/**
 * Try to detect a plan review layout.
 *
 * Requires two ╌╌╌╌ separators in `lines`, and the first non-blank line
 * must NOT match a permission label.
 */
function tryPlan(upperSep: number, lines: string[], opts: Options): InputArea | null {
  const seps: number[] = [];
  for (let i = 0; i < lines.length && seps.length < 2; i++) {
    if (CONTENT_SEPARATOR.test(lines[i] as string)) seps.push(i);
  }
  if (seps.length < 2) return null;

  // Disambiguate: permission tools have short command-style names
  const firstNonBlank = lines.slice(0, seps[0]).find((l) => l.trim());
  if (firstNonBlank && PERMISSION_LABEL.test(firstNonBlank)) return null;

  const planContent = lines.slice((seps[0] as number) + 1, seps[1]);
  const question = lines
    .slice((seps[1] as number) + 1)
    .filter((l) => l.trim())
    .map((l) => l.trim())
    .join(" ");

  return { upperSep, body: { kind: "plan_review", question, planContent, ...opts } };
}

/**
 * Parse numbered option lines (matching {@link OPTION}) from plain text lines.
 *
 * Each option may have an indented description on the following line.
 * The `❯` marker determines the selected option.
 */
function parseOptions(lines: string[]): Options {
  const result: Options = { options: [] };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(OPTION);
    if (!m) continue;
    if (m[1] === "❯") result.selected = result.options.length;
    const label = (m[2] ?? "").trim();

    const descLines: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1] as string;
      if (OPTION.test(next) || !next.match(/^\s{4,}/)) break;
      descLines.push(next.trim());
      i++;
    }
    const description = descLines.length > 0 ? descLines.join("\n") : undefined;
    result.options.push({ label, description });
  }
  return result;
}
