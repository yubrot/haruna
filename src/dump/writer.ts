/**
 * Append-only binary dump writer.
 *
 * Writes snapshot data in a compact binary format with automatic keyframe
 * insertion based on configurable time and size thresholds.
 *
 * @module
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FileSink } from "bun";
import type { Snapshot, SnapshotDelta } from "../vt/snapshot.ts";
import { computeSnapshotDiff } from "../vt/snapshot.ts";
import type { HeaderPayload } from "./frame.ts";
import { encodeFrame } from "./frame.ts";

/** Options for controlling keyframe insertion policy. */
export interface KeyframePolicy {
  /** Maximum milliseconds between keyframes (default: 5000). */
  keyframeIntervalMs?: number;
  /**
   * Insert a keyframe when cumulative delta bytes since the last keyframe
   * exceed this ratio multiplied by the last keyframe size (default: 2).
   */
  keyframeSizeRatio?: number;
}

/**
 * Append-only binary dump writer.
 *
 * Opens the file and writes a header frame on construction, then accepts a
 * sequence of keyframe and delta frames via {@link write}. Keyframes are
 * inserted automatically based on the configured policy.
 */
export class DumpWriter {
  private writer: FileSink | null;
  private readonly intervalMs: number;
  private readonly sizeRatio: number;

  private lastSnapshot: Snapshot | null = null;
  private lastKeyframeTime = 0;
  private bytesSinceKeyframe = 0;
  private lastKeyframeSize = 0;

  /**
   * Open the file and write the header frame.
   *
   * @param filePath - Path to the output file
   * @param header - Session metadata to write as the first frame
   * @param options - Keyframe insertion policy options
   */
  constructor(
    filePath: string,
    header: HeaderPayload,
    options?: KeyframePolicy,
  ) {
    this.intervalMs = options?.keyframeIntervalMs ?? 5000;
    this.sizeRatio = options?.keyframeSizeRatio ?? 2;

    mkdirSync(dirname(filePath), { recursive: true });
    this.writer = Bun.file(filePath).writer();
    this.writer.write(
      encodeFrame({ type: "header", timestamp: Date.now(), payload: header }),
    );
  }

  /**
   * Append a snapshot to the dump file as either a keyframe or a delta.
   *
   * The first snapshot is always written as a keyframe. Subsequent snapshots
   * are written as deltas unless:
   * - The time or size threshold triggers a new keyframe, or
   * - The diff cannot be expressed as a delta (e.g. non-leading deletes).
   *
   * @param snapshot - The snapshot to record
   */
  write(snapshot: Snapshot): void {
    if (!this.writer) throw new Error("DumpWriter is already closed");
    let delta: SnapshotDelta | null = null;
    if (this.lastSnapshot !== null) {
      const canDelta =
        snapshot.timestamp - this.lastKeyframeTime < this.intervalMs &&
        !(
          this.lastKeyframeSize > 0 &&
          this.bytesSinceKeyframe > this.lastKeyframeSize * this.sizeRatio
        );
      if (canDelta) {
        delta = computeSnapshotDiff(this.lastSnapshot, snapshot);
      }
    }

    if (delta !== null) {
      // Delta encoding against the previous snapshot
      const frame = encodeFrame({
        type: "delta",
        timestamp: snapshot.timestamp,
        payload: delta,
      });
      this.writer.write(frame);
      this.bytesSinceKeyframe += frame.length;
    } else {
      // Keyframe: first snapshot, policy threshold, or delta not expressible
      const { timestamp: _, ...rest } = snapshot;
      const frame = encodeFrame({
        type: "keyframe",
        timestamp: snapshot.timestamp,
        payload: rest,
      });
      this.writer.write(frame);
      this.lastKeyframeTime = snapshot.timestamp;
      this.lastKeyframeSize = frame.length;
      this.bytesSinceKeyframe = 0;
    }

    this.lastSnapshot = snapshot;
  }

  /**
   * Flush buffered data to the underlying file without closing it.
   */
  async flush(): Promise<void> {
    if (!this.writer) throw new Error("DumpWriter is already closed");
    await this.writer.flush();
  }

  /**
   * Flush remaining data and close the file.
   */
  async end(): Promise<void> {
    if (!this.writer) throw new Error("DumpWriter is already closed");
    await this.writer.flush();
    this.writer.end();
    this.writer = null;
  }

  /**
   * Write a header and a sequence of snapshots to a dump file in one call.
   *
   * @param filePath - Path to the output file
   * @param header - Session metadata for the header frame
   * @param snapshots - Snapshots to write
   * @param options - Keyframe insertion policy options
   */
  static async writeAll(
    filePath: string,
    header: HeaderPayload,
    snapshots: Snapshot[],
    options?: KeyframePolicy,
  ): Promise<void> {
    const w = new DumpWriter(filePath, header, options);
    for (const s of snapshots) w.write(s);
    await w.end();
  }
}
