/**
 * Binary dump reader with sequential and random-access capabilities.
 *
 * Reads dump files produced by {@link DumpWriter}, supporting both
 * sequential iteration over all snapshots and random-access by timestamp.
 *
 * @module
 */

import type { Snapshot, SnapshotDelta } from "../vt/snapshot.ts";
import { applySnapshotDiff, computeSnapshotDiff } from "../vt/snapshot.ts";
import type { HeaderPayload } from "./frame.ts";
import { decodeFrame } from "./frame.ts";

/** Index entry for a single snapshot frame in the dump file. */
interface IndexEntry {
  /** Byte offset of the frame in the file buffer. */
  offset: number;
  /** Frame type string. */
  type: "keyframe" | "delta";
  /** Timestamp from the frame. */
  timestamp: number;
}

/**
 * A snapshot with optional delta metadata.
 *
 * When the entry originates from a delta frame, `delta` describes the
 * change magnitude. For keyframes, `delta` is `null`.
 */
export interface SnapshotEntry {
  /** The fully reconstructed snapshot. */
  snapshot: Snapshot;
  /**
   * Delta change summary, or `null` for the following cases:
   * - The entry is the first snapshot (no predecessor).
   * - The entry is a keyframe and the diff from the previous snapshot
   *   cannot be expressed as a delta (e.g. `linesOffset` changed).
   */
  delta: {
    changedLines: number[];
    scrolledLines: number;
    cursorMoved: boolean;
  } | null;
}

/**
 * Binary dump reader.
 *
 * Loads a dump file into memory and builds an index for efficient access.
 * Supports sequential iteration via {@link snapshots} and random-access
 * reconstruction via {@link snapshotNearestTo}.
 */
export class DumpReader {
  private readonly buffer: Uint8Array;
  private readonly index: IndexEntry[];

  /** Session metadata from the header frame. */
  readonly header: HeaderPayload;

  /** Aggregate statistics computed from the index. */
  readonly stats: {
    keyframes: number;
    deltas: number;
    duration: { start: number; end: number } | null;
  };

  private constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.index = [];

    let offset: number;
    {
      const h = decodeFrame(buffer, 0);
      if (!h || h.frame.type !== "header") {
        throw new Error("Dump file has no header frame");
      }
      this.header = h.frame.payload;
      offset = h.nextOffset;
    }

    let keyframes = 0;
    let deltas = 0;

    while (offset < buffer.length) {
      const r = decodeFrame(buffer, offset);
      if (!r) break;

      if (r.frame.type === "keyframe" || r.frame.type === "delta") {
        this.index.push({
          offset,
          type: r.frame.type,
          timestamp: r.frame.timestamp,
        });
        if (r.frame.type === "keyframe") keyframes++;
        else deltas++;
      }
      offset = r.nextOffset;
    }

    const first = this.index[0];
    const last = this.index[this.index.length - 1];
    this.stats = {
      keyframes,
      deltas,
      duration:
        first && last ? { start: first.timestamp, end: last.timestamp } : null,
    };
  }

  /**
   * Open a dump file and build an in-memory index.
   *
   * @param filePath - Path to the dump file
   * @returns A ready-to-use reader instance
   * @throws When the file cannot be read or has an invalid format
   */
  static async open(filePath: string): Promise<DumpReader> {
    const file = Bun.file(filePath);
    const buffer = new Uint8Array(await file.arrayBuffer());
    return new DumpReader(buffer);
  }

  /**
   * Reconstruct the snapshot nearest to a given timestamp.
   *
   * @param timestamp - The target timestamp
   * @returns The reconstructed snapshot entry, or `null` if no snapshot exists at or before the timestamp
   */
  snapshotNearestTo(timestamp: number): SnapshotEntry | null {
    if (this.index.length === 0) return null;

    const targetIdx = this.upperBound(timestamp);
    if (targetIdx < 0) return null;

    const keyframeIdx = this.findKeyframeBefore(targetIdx);
    if (keyframeIdx < 0) return null;

    for (const entry of this.reconstruct(keyframeIdx, targetIdx, targetIdx)) {
      return entry;
    }
    return null;
  }

  /**
   * Iterate over snapshots in chronological order.
   *
   * Each iteration reconstructs the full snapshot from keyframes and deltas.
   *
   * @param from - When specified, iteration begins at the first entry whose
   *   timestamp is >= `from`. The necessary keyframe lookback is handled internally.
   * @yields Snapshot entries with delta metadata
   */
  *snapshots(from?: number): Generator<SnapshotEntry> {
    if (this.index.length === 0) return;

    let yieldFrom: number;
    if (from === undefined) {
      yieldFrom = 0;
    } else {
      yieldFrom = this.lowerBound(from);
      if (yieldFrom >= this.index.length) return;
    }

    const startKeyframe = this.findKeyframeBefore(yieldFrom);
    if (startKeyframe < 0) return;

    yield* this.reconstruct(startKeyframe, this.index.length - 1, yieldFrom);
  }

  /**
   * Binary search: find the index of the last entry with `timestamp <= target`.
   * Returns -1 if all entries are after the target.
   */
  private upperBound(target: number): number {
    let lo = 0;
    let hi = this.index.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const entry = this.index[mid] as IndexEntry;
      if (entry.timestamp <= target) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return result;
  }

  /**
   * Binary search: find the index of the first entry with `timestamp >= target`.
   * Returns `this.index.length` if all entries are before the target.
   */
  private lowerBound(target: number): number {
    let lo = 0;
    let hi = this.index.length - 1;
    let result = this.index.length;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const entry = this.index[mid] as IndexEntry;
      if (entry.timestamp >= target) {
        result = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    return result;
  }

  /** Find the nearest keyframe at or before the given index. */
  private findKeyframeBefore(idx: number): number {
    for (let i = idx; i >= 0; i--) {
      if ((this.index[i] as IndexEntry).type === "keyframe") return i;
    }
    return -1;
  }

  /**
   * Reconstruct snapshots by replaying frames from `startIdx` to `endIdx`.
   * Only yields entries at index >= `yieldFrom`.
   */
  private *reconstruct(
    startIdx: number,
    endIdx: number,
    yieldFrom: number,
  ): Generator<SnapshotEntry> {
    let current: Snapshot | null = null;

    for (let i = startIdx; i <= endIdx; i++) {
      const entry = this.index[i] as IndexEntry;
      const result = decodeFrame(this.buffer, entry.offset);
      if (!result) break;

      const { frame: record } = result;
      let deltaInfo: SnapshotEntry["delta"] = null;
      const prev = current;

      if (record.type === "keyframe") {
        current = { ...record.payload, timestamp: record.timestamp };
        if (prev) {
          const diff = computeSnapshotDiff(prev, current);
          if (diff) deltaInfo = summarizeDelta(diff);
        }
      } else if (record.type === "delta") {
        if (!current) throw new Error("Delta frame before any keyframe");
        deltaInfo = summarizeDelta(record.payload);
        current = applySnapshotDiff(current, record.payload, record.timestamp);
      }

      if (i >= yieldFrom && current) {
        yield { snapshot: current, delta: deltaInfo };
      }
    }
  }
}

function summarizeDelta(diff: SnapshotDelta): SnapshotEntry["delta"] {
  return {
    changedLines: diff.lines?.map(([idx]) => idx) ?? [],
    scrolledLines: diff.shift ?? 0,
    cursorMoved: diff.cursor !== undefined,
  };
}
