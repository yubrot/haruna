/**
 * Dump channel — thin {@link Channel} wrapper around {@link DumpWriter}.
 *
 * @module
 */

import type { KeyframePolicy } from "../dump/writer.ts";
import { DumpWriter } from "../dump/writer.ts";
import type { Channel, Frame } from "./interface.ts";

/** Options for creating a DumpChannel. */
export interface DumpChannelOptions {
  /** File path where the binary dump will be written. */
  filePath: string;
  /** The command that was spawned (recorded in the header). */
  command: string[];
  /** Keyframe insertion policy. */
  keyframePolicy?: KeyframePolicy;
}

/**
 * {@link Channel} adapter for {@link DumpWriter}.
 */
export class DumpChannel implements Channel {
  readonly name = "dump";
  private writer: DumpWriter | null = null;
  private readonly options: DumpChannelOptions;

  /**
   * Create a new DumpChannel.
   *
   * @param options - Dump configuration
   */
  constructor(options: DumpChannelOptions) {
    this.options = options;
  }

  /**
   * Open the dump file and write the header record.
   */
  async start(): Promise<void> {
    this.writer = new DumpWriter(
      this.options.filePath,
      { command: this.options.command },
      this.options.keyframePolicy,
    );
  }

  /**
   * Flush remaining data and close the writer.
   *
   * @returns A promise that resolves when all data has been flushed
   */
  async stop(): Promise<void> {
    await this.writer?.end();
  }

  /**
   * Record a snapshot from the frame.
   *
   * @param frame - The frame containing the snapshot to record
   */
  receive(frame: Frame): void {
    this.writer?.write(frame.snapshot);
  }
}
