import { program } from "commander";
import { Gateway } from "../gateway.ts";
import { type PtySession, runPty } from "../pty/index.ts";
import { VirtualTerminal } from "../vt/index.ts";

program
  .name("haruna")
  .argument("<command>", "command to run")
  .argument("[args...]", "arguments for the command")
  .allowExcessArguments(true)
  .action(async (command: string, args: string[]) => {
    let session: PtySession | null = null;

    const gateway = new Gateway({
      write: (bytes) => session?.write(bytes),
    });

    const vt = new VirtualTerminal({
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      scrollback: 500,
      onChange: (snapshot) => gateway.update(snapshot),
    });

    session = runPty({
      command: [command, ...args],
      onData: (data) => vt.write(data),
      onResize: (newCols, newRows) => vt.resize(newCols, newRows),
    });

    let exitCode = 1;
    try {
      exitCode = await session.exited;
      await vt.flush();
    } catch (e) {
      console.error(`haruna: ${e instanceof Error ? e.message : e}`);
    } finally {
      vt.dispose();
    }
    process.exit(exitCode);
  });

program.parse();
