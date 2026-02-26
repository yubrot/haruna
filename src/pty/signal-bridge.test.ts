import { describe, expect, test } from "bun:test";
import { scanChunk } from "./signal-bridge.ts";

/** Helper to create a Uint8Array from a sequence of byte values. */
function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("scanChunk", () => {
  describe("control character detection", () => {
    test("detects Ctrl+C (0x03) as SIGINT", () => {
      const result = scanChunk(bytes(0x03));
      expect(result.signals).toEqual(["SIGINT"]);
      expect(result.data).toEqual([]);
    });

    test("detects Ctrl+Z (0x1a) as SIGTSTP", () => {
      const result = scanChunk(bytes(0x1a));
      expect(result.signals).toEqual(["SIGTSTP"]);
      expect(result.data).toEqual([]);
    });

    test("detects Ctrl+\\ (0x1c) as SIGQUIT", () => {
      const result = scanChunk(bytes(0x1c));
      expect(result.signals).toEqual(["SIGQUIT"]);
      expect(result.data).toEqual([]);
    });
  });

  describe("plain data passthrough", () => {
    test("passes through regular ASCII data", () => {
      const input = new TextEncoder().encode("hello");
      const result = scanChunk(input);
      expect(result.signals).toEqual([]);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual(input);
    });

    test("passes through an empty chunk", () => {
      const result = scanChunk(bytes());
      expect(result.signals).toEqual([]);
      expect(result.data).toEqual([]);
    });

    test("passes through other control characters (e.g. TAB, ESC)", () => {
      const input = bytes(0x09, 0x1b, 0x0d); // TAB, ESC, CR
      const result = scanChunk(input);
      expect(result.signals).toEqual([]);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual(input);
    });
  });

  describe("mixed input (paste scenarios)", () => {
    test("splits data around a control character in the middle", () => {
      // "he" + Ctrl+C + "llo"
      const input = bytes(0x68, 0x65, 0x03, 0x6c, 0x6c, 0x6f);
      const result = scanChunk(input);
      expect(result.signals).toEqual(["SIGINT"]);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual(bytes(0x68, 0x65)); // "he"
      expect(result.data[1]).toEqual(bytes(0x6c, 0x6c, 0x6f)); // "llo"
    });

    test("handles control character at the start followed by data", () => {
      // Ctrl+C + "abc"
      const input = bytes(0x03, 0x61, 0x62, 0x63);
      const result = scanChunk(input);
      expect(result.signals).toEqual(["SIGINT"]);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual(bytes(0x61, 0x62, 0x63));
    });

    test("handles data followed by control character at the end", () => {
      // "abc" + Ctrl+Z
      const input = bytes(0x61, 0x62, 0x63, 0x1a);
      const result = scanChunk(input);
      expect(result.signals).toEqual(["SIGTSTP"]);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual(bytes(0x61, 0x62, 0x63));
    });

    test("handles multiple consecutive control characters", () => {
      // Ctrl+C + Ctrl+C + Ctrl+Z
      const input = bytes(0x03, 0x03, 0x1a);
      const result = scanChunk(input);
      expect(result.signals).toEqual(["SIGINT", "SIGINT", "SIGTSTP"]);
      expect(result.data).toEqual([]);
    });

    test("handles alternating data and control characters", () => {
      // "a" + Ctrl+C + "b" + Ctrl+Z + "c"
      const input = bytes(0x61, 0x03, 0x62, 0x1a, 0x63);
      const result = scanChunk(input);
      expect(result.signals).toEqual(["SIGINT", "SIGTSTP"]);
      expect(result.data).toHaveLength(3);
      expect(result.data[0]).toEqual(bytes(0x61)); // "a"
      expect(result.data[1]).toEqual(bytes(0x62)); // "b"
      expect(result.data[2]).toEqual(bytes(0x63)); // "c"
    });
  });
});
