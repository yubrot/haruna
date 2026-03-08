#!/usr/bin/env bun

/**
 * CLI entry point — argument parsing, routing, and dispatch.
 *
 * @module
 */

import { dirname, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { Config, findConfigFile } from "../config.ts";
import { runDump } from "./dump.ts";
import { runExec } from "./exec.ts";
import { runRecord } from "./record.ts";
import { runReplay } from "./replay.ts";
import { ensureTrusted, runTrust } from "./trust.ts";

/**
 * Load configuration from an explicit path or by searching upward from cwd.
 *
 * Checks directory trust before loading the config file.
 *
 * @param configPath - Explicit config file path, or `undefined` to search
 * @returns Resolved configuration
 */
async function loadConfig(configPath?: string): Promise<Config> {
  try {
    const configFile = configPath ? resolve(configPath) : findConfigFile(process.cwd());
    if (configFile) {
      await ensureTrusted(dirname(configFile));
    }
    return configFile
      ? await Config.load(configFile, dirname(configFile))
      : await Config.load(null, process.cwd());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[haruna] Failed to load config: ${message}`);
    process.exit(1);
  }
}

const program = new Command();

program
  .name("haruna")
  .description(
    "A TUI-agnostic bridge that wraps interactive CLI tools and bridges conversations to Channels (Discord, Slack, ...)",
  )
  .enablePositionalOptions();

// exec (default command)
program
  .command("exec", { isDefault: true })
  .description("Run a command in a PTY (default subcommand)")
  .option("-c, --config <path>", "path to config file")
  .argument("[command...]", "command and arguments to run")
  .passThroughOptions()
  .action(async (args: string[], opts: { config?: string }) => {
    const config = await loadConfig(opts.config);
    process.exit(await runExec(args, config));
  });

// replay
program
  .command("replay")
  .description("Replay a dump file through the event pipeline")
  .option("-c, --config <path>", "path to config file")
  .argument("<file>", "dump file path")
  .action(async (file: string, opts: { config?: string }) => {
    const config = await loadConfig(opts.config);
    process.exit(await runReplay(file, config));
  });

// record
program
  .command("record")
  .description("Run a procedure script and capture VT snapshots to a dump file")
  .argument("<script>", "procedure script path (YAML)")
  .option("-o, --output <path>", "output dump file path")
  .action(async (script: string, opts: { output?: string }) => {
    process.exit(await runRecord(script, opts.output));
  });

// trust
program
  .command("trust")
  .description("Manage trusted config directories")
  .argument("[dir]", "directory to trust or revoke (default: cwd)")
  .option("--revoke", "revoke trust for the directory")
  .option("--list", "list all trusted directories")
  .action(async (dir: string | undefined, opts: { revoke?: true; list?: true }) => {
    process.exit(await runTrust(dir, opts));
  });

// dump
program
  .command("dump")
  .description("Inspect binary dump files")
  .option("-c, --config <path>", "path to config file")
  .argument("<file>", "dump file path")
  .option("--stats", "include metadata and statistics")
  .option("--list", "list snapshots")
  .option(
    "--diff [level]",
    "include diffs: 0=first-last (default), 1=sequential deduped, 2=all",
    parseDiffLevel,
  )
  .option("--at <ts>", "include snapshot at specific timestamp")
  .option("--scene [level]", "enrich output with scene analysis (type or verbose)")
  .option("--search <pattern>", "filter --list entries by regex pattern")
  .option("--from <ts>", "start timestamp for --list/--diff range")
  .option("--to <ts>", "end timestamp for --list/--diff range")
  .option("--count <n>", "max entries (default: 100, max: 1000)", (value) => {
    const n = parsePositiveInt(value, "count");
    if (n > 1000) throw new InvalidArgumentError("count must not exceed 1000.");
    return n;
  })
  .option(
    "--context <n>",
    "context lines around diff changes (default: 3, -1 for all)",
    (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed < -1) {
        throw new InvalidArgumentError("context must be an integer >= -1.");
      }
      return parsed;
    },
  )
  .option("--json", "output in JSON format")
  .action(
    async (
      file: string,
      opts: {
        config?: string;
        stats?: true;
        list?: true;
        diff?: 0 | 1 | 2 | true;
        at?: string;
        scene?: string | true;
        search?: string;
        from?: string;
        to?: string;
        count?: number;
        context?: number;
        json?: true;
      },
    ) => {
      // Normalize individual option defaults
      // Commander passes `true` for `--diff` without a value; treat as level 0
      const diff = opts.diff === undefined ? null : opts.diff === true ? 0 : opts.diff;
      let stats = opts.stats ?? false;
      let list = opts.list ?? false;

      // Apply composite default rules
      const hasActionFlag = stats || list || diff !== null || opts.at !== undefined;
      const hasRangeOrSearch =
        opts.from !== undefined || opts.to !== undefined || opts.search !== undefined;

      if (!hasActionFlag) {
        if (hasRangeOrSearch) {
          list = true;
        } else {
          stats = true;
          list = true;
        }
      }

      // Normalize --scene: undefined → false, true (no value) → "type", string → validated level
      let scene: "type" | "verbose" | false = false;
      if (opts.scene === true) {
        scene = "type";
      } else if (opts.scene !== undefined) {
        if (opts.scene !== "type" && opts.scene !== "verbose") {
          throw new InvalidArgumentError(
            `Invalid scene level: ${opts.scene}. Must be "type" or "verbose".`,
          );
        }
        scene = opts.scene;
      }

      const config = await loadConfig(opts.config);
      process.exit(
        await runDump(
          {
            file,
            stats,
            list,
            diff,
            at: opts.at,
            scene,
            search: opts.search,
            from: opts.from,
            to: opts.to,
            count: opts.count ?? 100,
            context: opts.context === undefined ? 3 : opts.context === -1 ? null : opts.context,
            json: opts.json ?? false,
          },
          config,
        ),
      );
    },
  );

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseDiffLevel(value: string): 0 | 1 | 2 {
  const parsed = Number.parseInt(value, 10);
  if (parsed !== 0 && parsed !== 1 && parsed !== 2) {
    throw new InvalidArgumentError("Diff level must be 0, 1, or 2.");
  }
  return parsed as 0 | 1 | 2;
}

// Entry point
if (import.meta.main) {
  await program.parseAsync(process.argv);
}
