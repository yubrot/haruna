import { describe, expect, test } from "bun:test";
import { type DumpFrame, decodeFrame, encodeFrame } from "./frame.ts";

describe("encodeFrame / decodeFrame", () => {
  test("roundtrip preserves type, timestamp, and payload for keyframe", () => {
    const frame: DumpFrame = {
      type: "keyframe",
      timestamp: 1700000000000,
      payload: {
        lines: ["hello"],
        cursor: { x: 0, y: 0, visible: true },
        cols: 80,
        rows: 24,
        alternate: false,
        linesOffset: 0,
      },
    };
    const encoded = encodeFrame(frame);

    const decoded = decodeFrame(encoded, 0);
    expect(decoded).not.toBeNull();
    expect(decoded?.frame.type).toBe("keyframe");
    expect(decoded?.frame.timestamp).toBe(1700000000000);
    expect(decoded?.frame.payload).toEqual(frame.payload);
    expect(decoded?.nextOffset).toBe(encoded.length);
  });

  test("roundtrip preserves header frame", () => {
    const frame: DumpFrame = {
      type: "header",
      timestamp: 1700000000000,
      payload: { command: ["claude", "--model", "opus"] },
    };
    const encoded = encodeFrame(frame);

    const decoded = decodeFrame(encoded, 0);
    expect(decoded).not.toBeNull();
    expect(decoded?.frame.type).toBe("header");
    expect(decoded?.frame.payload).toEqual({
      command: ["claude", "--model", "opus"],
    });
  });

  test("roundtrip preserves delta frame", () => {
    const frame: DumpFrame = {
      type: "delta",
      timestamp: 1700000000000,
      payload: {
        lines: [[0, "changed"]],
        cursor: { x: 5, y: 3, visible: false },
      },
    };
    const encoded = encodeFrame(frame);

    const decoded = decodeFrame(encoded, 0);
    expect(decoded).not.toBeNull();
    expect(decoded?.frame.type).toBe("delta");
    expect(decoded?.frame.payload).toEqual(frame.payload);
  });

  test("payload is lazily decoded and cached", () => {
    const frame: DumpFrame = {
      type: "header",
      timestamp: 0,
      payload: { command: ["test"] },
    };
    const encoded = encodeFrame(frame);
    const decoded = decodeFrame(encoded, 0);
    expect(decoded).not.toBeNull();
    const first = decoded?.frame.payload;
    const second = decoded?.frame.payload;
    expect(first).toBe(second); // same reference
  });

  test("returns null for insufficient data", () => {
    const short = new Uint8Array(5);
    expect(decodeFrame(short, 0)).toBeNull();
  });

  test("returns null for truncated payload", () => {
    const frame: DumpFrame = {
      type: "header",
      timestamp: 0,
      payload: { command: ["test"] },
    };
    const encoded = encodeFrame(frame);
    const truncated = encoded.subarray(0, encoded.length - 1);
    expect(decodeFrame(truncated, 0)).toBeNull();
  });

  test("returns null for unknown frame type", () => {
    const frame: DumpFrame = {
      type: "header",
      timestamp: 0,
      payload: { command: ["test"] },
    };
    const encoded = encodeFrame(frame);
    // Overwrite type byte with an unknown value
    encoded[0] = 0xff;
    expect(decodeFrame(encoded, 0)).toBeNull();
  });

  test("multiple frames in sequence", () => {
    const f1: DumpFrame = {
      type: "header",
      timestamp: 100,
      payload: { command: ["test"] },
    };
    const f2: DumpFrame = {
      type: "delta",
      timestamp: 200,
      payload: { lines: [[1, "changed"]] },
    };
    const e1 = encodeFrame(f1);
    const e2 = encodeFrame(f2);
    const combined = new Uint8Array(e1.length + e2.length);
    combined.set(e1, 0);
    combined.set(e2, e1.length);

    const d1 = decodeFrame(combined, 0);
    expect(d1).not.toBeNull();
    expect(d1?.frame.type).toBe("header");
    expect(d1?.frame.payload).toEqual({ command: ["test"] });

    const d2 = decodeFrame(combined, d1?.nextOffset ?? 0);
    expect(d2).not.toBeNull();
    expect(d2?.frame.type).toBe("delta");
    expect(d2?.frame.payload).toEqual({ lines: [[1, "changed"]] });
  });
});
