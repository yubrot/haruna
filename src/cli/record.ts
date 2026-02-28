/**
 * Record command — CLI wrapper for the record engine.
 *
 * Handles file I/O, argument resolution, and user-facing messages.
 *
 * @module
 */

import { join, parse } from "node:path";
import {
  parseRecordScript,
  type RecordScript,
  recordDump,
} from "../dump/recorder.ts";

/**
 * Determine the output dump file path from the script path.
 *
 * Replaces the file extension with `.dump`.
 *
 * @param scriptPath - Path to the procedure script
 * @returns Path for the output dump file
 */
export function defaultOutputPath(scriptPath: string): string {
  const { dir, name } = parse(scriptPath);
  return join(dir, `${name}.dump`);
}

/**
 * Run a record procedure script and write snapshots to a dump file.
 *
 * @param scriptPath - Path to the YAML procedure script
 * @param outputPath - Path for the output dump file (optional; defaults to scriptPath with .dump extension)
 * @returns Exit code (0 on success, 1 on error)
 */
export async function runRecord(
  scriptPath: string,
  outputPath?: string,
): Promise<number> {
  let content: string;
  try {
    content = await Bun.file(scriptPath).text();
  } catch (e) {
    console.error(
      `[haruna] cannot read script: ${e instanceof Error ? e.message : e}`,
    );
    return 1;
  }

  let script: RecordScript;
  try {
    script = parseRecordScript(content);
  } catch (e) {
    console.error(
      `[haruna] invalid script: ${e instanceof Error ? e.message : e}`,
    );
    return 1;
  }

  const outPath = outputPath ?? defaultOutputPath(scriptPath);

  try {
    const count = await recordDump(script, outPath);
    console.error(`[haruna] recorded ${count} snapshot(s) to ${outPath}`);
    return 0;
  } catch (e) {
    console.error(`[haruna] ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}
