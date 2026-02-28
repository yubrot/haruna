import { describe, expect, test } from "bun:test";
import { formatDate, formatTime, resolveTimestamp } from "./time.ts";

describe("resolveTimestamp", () => {
  const base = 1000000;

  test("parses absolute timestamp", () => {
    expect(resolveTimestamp("1705312800000", base)).toBe(1705312800000);
  });

  test("parses relative seconds", () => {
    expect(resolveTimestamp("3s", base)).toBe(1000000 + 3000);
  });

  test("parses relative milliseconds", () => {
    expect(resolveTimestamp("100ms", base)).toBe(1000000 + 100);
  });

  test("parses relative minutes", () => {
    expect(resolveTimestamp("2m", base)).toBe(1000000 + 120000);
  });

  test("parses fractional seconds", () => {
    expect(resolveTimestamp("1.5s", base)).toBe(1000000 + 1500);
  });

  test("throws on invalid format", () => {
    expect(() => resolveTimestamp("abc", base)).toThrow(
      "Invalid timestamp format",
    );
  });
});

describe("formatDate", () => {
  test("formats timestamp as UTC date+time", () => {
    // 2024-01-15T12:30:00.000Z
    const ts = Date.UTC(2024, 0, 15, 12, 30, 0);
    expect(formatDate(ts)).toBe("2024-01-15 12:30:00");
  });

  test("zero-pads single-digit components", () => {
    // 2024-03-05T09:05:07.000Z
    const ts = Date.UTC(2024, 2, 5, 9, 5, 7);
    expect(formatDate(ts)).toBe("2024-03-05 09:05:07");
  });
});

describe("formatTime", () => {
  test("formats timestamp as UTC time only", () => {
    // 2024-01-15T12:30:45.000Z
    const ts = Date.UTC(2024, 0, 15, 12, 30, 45);
    expect(formatTime(ts)).toBe("12:30:45");
  });

  test("zero-pads single-digit components", () => {
    // 2024-01-01T01:02:03.000Z
    const ts = Date.UTC(2024, 0, 1, 1, 2, 3);
    expect(formatTime(ts)).toBe("01:02:03");
  });
});
