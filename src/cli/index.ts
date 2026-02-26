import { program } from "commander";
import { runPty } from "../pty/index.ts";

program
  .name("haruna")
  .argument("<command>", "command to run")
  .argument("[args...]", "arguments for the command")
  .allowExcessArguments(true)
  .action(async (command: string, args: string[]) => {
    const session = runPty({ command: [command, ...args] });
    const exitCode = await session.exited;
    process.exit(exitCode);
  });

program.parse();
