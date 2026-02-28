/**
 * Encoding and decoding of individual framed records in a dump file.
 *
 * @module
 */

import { Packr, Unpackr } from "msgpackr";
import type { Snapshot, SnapshotDelta } from "../vt/snapshot.ts";

/** A decoded record from a dump file. */
export type DumpRecord = HeaderRecord | KeyframeRecord | DeltaRecord;

/** Session metadata stored in a header record. */
export interface HeaderPayload {
  /** The command that was spawned (e.g. `["claude"]`). */
  command: string[];
}

/** A header record containing session metadata. */
export interface HeaderRecord {
  type: "header";
  timestamp: number;
  payload: HeaderPayload;
}

/** A keyframe record containing a full snapshot (without timestamp). */
export interface KeyframeRecord {
  type: "keyframe";
  timestamp: number;
  payload: Omit<Snapshot, "timestamp">;
}

/** A delta record containing the difference from the previous snapshot. */
export interface DeltaRecord {
  type: "delta";
  timestamp: number;
  payload: SnapshotDelta;
}

const packr = new Packr();
const unpackr = new Unpackr();

// Wire format: [type: u8] [timestamp: f64 BE] [length: u32 BE] [payload (MessagePack)]
// Frame header size in bytes: type (1) + timestamp (8) + length (4).
const FRAME_HEADER_SIZE = 13;

// Wire record type constants
const HEADER = 0x01;
const KEYFRAME = 0x02;
const DELTA = 0x03;

/**
 * Encode a record into a framed binary representation.
 *
 * @param record - The record to encode
 * @returns A buffer containing the complete framed record
 */
export function encodeRecord(record: DumpRecord): Uint8Array {
  let typeTag: number;
  switch (record.type) {
    case "header":
      typeTag = HEADER;
      break;
    case "keyframe":
      typeTag = KEYFRAME;
      break;
    case "delta":
      typeTag = DELTA;
      break;
  }

  const payload: Uint8Array = packr.pack(record.payload);
  const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  frame[0] = typeTag;
  view.setFloat64(1, record.timestamp, false); // big-endian
  view.setUint32(9, payload.length, false); // big-endian
  frame.set(payload, FRAME_HEADER_SIZE);
  return frame;
}

/** Result of decoding a single record from a buffer. */
export interface DecodeResult {
  /** The decoded record. */
  record: DumpRecord;
  /** Byte offset of the next record in the buffer. */
  nextOffset: number;
}

/**
 * Decode a record frame at the given offset.
 *
 * Payload deserialization is deferred until the `payload` property is accessed
 * (lazy getter with caching). Unknown record types return `null`.
 *
 * @param buffer - The buffer to read from
 * @param offset - Byte offset into the buffer
 * @returns The decoded record and next offset, or `null` if insufficient data or unknown type
 */
export function decodeRecord(
  buffer: Uint8Array,
  offset: number,
): DecodeResult | null {
  if (offset + FRAME_HEADER_SIZE > buffer.length) return null;
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset + offset,
    FRAME_HEADER_SIZE,
  );
  const typeTag = buffer[offset] as number;
  const timestamp = view.getFloat64(1, false);
  const length = view.getUint32(9, false);
  const nextOffset = offset + FRAME_HEADER_SIZE + length;
  if (nextOffset > buffer.length) return null;

  let type: DumpRecord["type"];
  switch (typeTag) {
    case HEADER:
      type = "header";
      break;
    case KEYFRAME:
      type = "keyframe";
      break;
    case DELTA:
      type = "delta";
      break;
    default:
      return null;
  }

  // Lazy payload deserialization with caching
  let cached: unknown;
  let decoded = false;
  const lazyPayload = () => {
    if (!decoded) {
      cached = unpackr.unpack(
        buffer.subarray(offset + FRAME_HEADER_SIZE, nextOffset),
      );
      decoded = true;
    }
    return cached;
  };

  const record = {
    type,
    timestamp,
    get payload() {
      return lazyPayload();
    },
  } as DumpRecord;

  return { record, nextOffset };
}
