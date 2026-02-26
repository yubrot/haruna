/**
 * Signal bridge for PTY input handling.
 *
 * @module
 */

/** Mapping from control character byte to signal name. */
const CONTROL_SIGNALS: ReadonlyMap<number, NodeJS.Signals> = new Map([
  [0x03, "SIGINT"], // Ctrl+C
  [0x1a, "SIGTSTP"], // Ctrl+Z
  [0x1c, "SIGQUIT"], // Ctrl+\
]);

/** Result of processing a chunk of stdin data. */
export interface BridgeResult {
  /** Signals detected in the input, in order of occurrence. */
  signals: NodeJS.Signals[];
  /** Non-control data segments to forward to the terminal, in order. */
  data: Uint8Array[];
}

/**
 * Scan a chunk of stdin data for control characters.
 *
 * @param chunk - Raw stdin data to process
 * @returns Signals to deliver and data to forward
 */
export function scanChunk(chunk: Uint8Array): BridgeResult {
  // Bun.Terminal.write() bypasses PTY line discipline (bun#25779), so
  // control characters must be intercepted and delivered as signals manually.
  const signals: NodeJS.Signals[] = [];
  const data: Uint8Array[] = [];

  let segmentStart = -1;

  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i];
    if (byte === undefined) continue; // unreachable; satisfies noUncheckedIndexedAccess
    const signal = CONTROL_SIGNALS.get(byte);
    if (signal) {
      // Flush any pending data segment before the control character
      if (segmentStart !== -1) {
        data.push(chunk.slice(segmentStart, i));
        segmentStart = -1;
      }
      signals.push(signal);
    } else {
      if (segmentStart === -1) {
        segmentStart = i;
      }
    }
  }

  // Flush trailing data segment
  if (segmentStart !== -1) {
    data.push(chunk.slice(segmentStart));
  }

  return { signals, data };
}
