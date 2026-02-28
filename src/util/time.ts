/**
 * Time representation and conversion utilities.
 *
 * Handles both parsing (string → number) and formatting (number → string)
 * of timestamps and durations.
 *
 * @module
 */

/**
 * A timestamp value: either an absolute millisecond number or a string
 * to be resolved via {@link resolveTimestamp} against a base time.
 */
export type Timestamp = number | string;

/**
 * Parse a timestamp string into an absolute millisecond value.
 *
 * Supports absolute ms (`"1705312800000"`) and relative offsets
 * from a base time (`"3s"`, `"100ms"`, `"2m"`).
 *
 * @param input - The timestamp string to parse
 * @param base - The base timestamp for relative offsets (ms)
 * @returns The resolved absolute timestamp in milliseconds
 * @throws {Error} When the input format is not recognized
 */
export function resolveTimestamp(input: string | number, base: number): number {
  if (typeof input === "number") return input;

  // Relative: "100ms"
  const msMatch = input.match(/^(\d+(?:\.\d+)?)ms$/);
  if (msMatch) return base + Number(msMatch[1]);

  // Relative: "3s"
  const sMatch = input.match(/^(\d+(?:\.\d+)?)s$/);
  if (sMatch) return base + Number(sMatch[1]) * 1000;

  // Relative: "2m"
  const mMatch = input.match(/^(\d+(?:\.\d+)?)m$/);
  if (mMatch) return base + Number(mMatch[1]) * 60_000;

  // Absolute: pure digits
  if (/^\d+$/.test(input)) return Number(input);

  throw new Error(`Invalid timestamp format: ${input}`);
}

/**
 * Format a timestamp as a date+time string (`YYYY-MM-DD HH:MM:SS`).
 *
 * @param ts - Absolute timestamp in milliseconds
 */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  return d
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

/**
 * Format a timestamp as a time-only string (`HH:MM:SS`).
 *
 * @param ts - Absolute timestamp in milliseconds
 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d
    .toISOString()
    .replace(/^.*T/, "")
    .replace(/\.\d+Z$/, "");
}
