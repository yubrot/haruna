import { describe, expect, test } from "bun:test";
import { type DumpRecord, decodeRecord, encodeRecord } from "./record.ts";

describe("encodeRecord / decodeRecord", () => {
  test("roundtrip preserves type, timestamp, and payload for keyframe", () => {
    const record: DumpRecord = {
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
    const frame = encodeRecord(record);

    const decoded = decodeRecord(frame, 0);
    expect(decoded).not.toBeNull();
    expect(decoded?.record.type).toBe("keyframe");
    expect(decoded?.record.timestamp).toBe(1700000000000);
    expect(decoded?.record.payload).toEqual(record.payload);
    expect(decoded?.nextOffset).toBe(frame.length);
  });

  test("roundtrip preserves header record", () => {
    const record: DumpRecord = {
      type: "header",
      timestamp: 1700000000000,
      payload: { command: ["claude", "--model", "opus"] },
    };
    const frame = encodeRecord(record);

    const decoded = decodeRecord(frame, 0);
    expect(decoded).not.toBeNull();
    expect(decoded?.record.type).toBe("header");
    expect(decoded?.record.payload).toEqual({
      command: ["claude", "--model", "opus"],
    });
  });

  test("roundtrip preserves delta record", () => {
    const record: DumpRecord = {
      type: "delta",
      timestamp: 1700000000000,
      payload: {
        lines: [[0, "changed"]],
        cursor: { x: 5, y: 3, visible: false },
      },
    };
    const frame = encodeRecord(record);

    const decoded = decodeRecord(frame, 0);
    expect(decoded).not.toBeNull();
    expect(decoded?.record.type).toBe("delta");
    expect(decoded?.record.payload).toEqual(record.payload);
  });

  test("payload is lazily decoded and cached", () => {
    const record: DumpRecord = {
      type: "header",
      timestamp: 0,
      payload: { command: ["test"] },
    };
    const frame = encodeRecord(record);
    const decoded = decodeRecord(frame, 0);
    expect(decoded).not.toBeNull();
    const first = decoded?.record.payload;
    const second = decoded?.record.payload;
    expect(first).toBe(second); // same reference
  });

  test("returns null for insufficient data", () => {
    const short = new Uint8Array(5);
    expect(decodeRecord(short, 0)).toBeNull();
  });

  test("returns null for truncated payload", () => {
    const record: DumpRecord = {
      type: "header",
      timestamp: 0,
      payload: { command: ["test"] },
    };
    const frame = encodeRecord(record);
    const truncated = frame.subarray(0, frame.length - 1);
    expect(decodeRecord(truncated, 0)).toBeNull();
  });

  test("returns null for unknown record type", () => {
    const record: DumpRecord = {
      type: "header",
      timestamp: 0,
      payload: { command: ["test"] },
    };
    const frame = encodeRecord(record);
    // Overwrite type byte with an unknown value
    frame[0] = 0xff;
    expect(decodeRecord(frame, 0)).toBeNull();
  });

  test("multiple records in sequence", () => {
    const r1: DumpRecord = {
      type: "header",
      timestamp: 100,
      payload: { command: ["test"] },
    };
    const r2: DumpRecord = {
      type: "delta",
      timestamp: 200,
      payload: { lines: [[1, "changed"]] },
    };
    const f1 = encodeRecord(r1);
    const f2 = encodeRecord(r2);
    const combined = new Uint8Array(f1.length + f2.length);
    combined.set(f1, 0);
    combined.set(f2, f1.length);

    const d1 = decodeRecord(combined, 0);
    expect(d1).not.toBeNull();
    expect(d1?.record.type).toBe("header");
    expect(d1?.record.payload).toEqual({ command: ["test"] });

    const d2 = decodeRecord(combined, d1?.nextOffset ?? 0);
    expect(d2).not.toBeNull();
    expect(d2?.record.type).toBe("delta");
    expect(d2?.record.payload).toEqual({ lines: [[1, "changed"]] });
  });
});
