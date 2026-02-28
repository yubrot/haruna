/**
 * Encoding and decoding of individual frames in a dump file.
 *
 * @module
 */

import { Packr, Unpackr } from "msgpackr";
import type { Snapshot, SnapshotDelta } from "../vt/snapshot.ts";

/** A decoded frame from a dump file. */
export type DumpFrame = Header | Keyframe | Delta;

/** Session metadata stored in a header frame. */
export interface HeaderPayload {
  /** The command that was spawned (e.g. `["claude"]`). */
  command: string[];
}

/** A header frame containing session metadata. */
export interface Header {
  type: "header";
  timestamp: number;
  payload: HeaderPayload;
}

/** A keyframe containing a full snapshot (without timestamp). */
export interface Keyframe {
  type: "keyframe";
  timestamp: number;
  payload: Omit<Snapshot, "timestamp">;
}

/** A delta frame containing the difference from the previous snapshot. */
export interface Delta {
  type: "delta";
  timestamp: number;
  payload: SnapshotDelta;
}

const packr = new Packr();
const unpackr = new Unpackr();

// Wire format: [type: u8] [timestamp: f64 BE] [length: u32 BE] [payload (MessagePack)]
// Frame header size in bytes: type (1) + timestamp (8) + length (4).
const FRAME_HEADER_SIZE = 13;

// Wire frame type constants
const HEADER = 0x01;
const KEYFRAME = 0x02;
const DELTA = 0x03;

/**
 * Encode a frame into a framed binary representation.
 *
 * @param frame - The frame to encode
 * @returns A buffer containing the complete frame
 */
export function encodeFrame(frame: DumpFrame): Uint8Array {
  let typeTag: number;
  switch (frame.type) {
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

  const payload: Uint8Array = packr.pack(frame.payload);
  const buf = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf[0] = typeTag;
  view.setFloat64(1, frame.timestamp, false); // big-endian
  view.setUint32(9, payload.length, false); // big-endian
  buf.set(payload, FRAME_HEADER_SIZE);
  return buf;
}

/** Result of decoding a single frame from a buffer. */
export interface DecodeResult {
  /** The decoded frame. */
  frame: DumpFrame;
  /** Byte offset of the next frame in the buffer. */
  nextOffset: number;
}

/**
 * Decode a frame at the given offset.
 *
 * Payload deserialization is deferred until the `payload` property is accessed
 * (lazy getter with caching). Unknown frame types return `null`.
 *
 * @param buffer - The buffer to read from
 * @param offset - Byte offset into the buffer
 * @returns The decoded frame and next offset, or `null` if insufficient data or unknown type
 */
export function decodeFrame(
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

  let type: DumpFrame["type"];
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

  const frame = {
    type,
    timestamp,
    get payload() {
      return lazyPayload();
    },
  } as DumpFrame;

  return { frame, nextOffset };
}
