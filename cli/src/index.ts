#!/usr/bin/env bun
import { Command } from "commander";
import { connect, type ConnectOptions } from "./commands/connect";
import { disconnect } from "./commands/disconnect";
import { status, type StatusOptions } from "./commands/status";
import { runRemote } from "./remote/exec";
import { findConnection } from "./config/store";
import { error } from "./utils/spinner";

const RESERVED_COMMANDS = new Set(["connect", "disconnect", "status", "help", "--help", "-h", "--version", "-V"]);

const program = new Command();

program
  .name("haven")
  .description("Haven CLI - Local editor + remote AI coding environment")
  .version("0.1.0");

program
  .command("connect [path] [target]")
  .description("Connect to remote EnvHaven workspace")
  .option("--idle-timeout <duration>", "Override idle timeout (e.g., 30m, 1h, 2h)")
  .option("--reset-host-key", "Remove cached host key (use after workspace rebuild)")
  .option("--use-gitignore", "Exclude files matching .gitignore patterns from sync")
  .action(async (path: string | undefined, target: string | undefined, options: ConnectOptions) => {
    try {
      await connect(path, { ...options, target });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("disconnect [path]")
  .description("Disconnect from remote workspace")
  .action(async (path: string | undefined) => {
    try {
      await disconnect(path);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("status [path]")
  .description("Show connection status")
  .option("-w, --watch", "Watch mode - continuously update status")
  .option("--json", "Output in JSON format")
  .option("--diagnose", "Run diagnostic checks")
  .action(async (path: string | undefined, options: StatusOptions) => {
    try {
      await status(path, options);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

async function handleRemoteCommand(args: string[]): Promise<void> {
  const found = findConnection(process.cwd());

  if (!found) {
    error("Not connected. Run 'haven connect <path>' first.");
    process.exit(1);
  }

  const { localPath, config } = found;

  if (!config.sshAlias) {
    error("Invalid connection state. Try reconnecting.");
    process.exit(1);
  }

  const exitCode = await runRemote(config.sshAlias, config, localPath, args);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    program.help();
    return;
  }

  const firstArg = args[0];

  if (firstArg === "--") {
    await handleRemoteCommand(args.slice(1));
    return;
  }

  if (firstArg && !RESERVED_COMMANDS.has(firstArg) && !firstArg.startsWith("-")) {
    await handleRemoteCommand(args);
    return;
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
