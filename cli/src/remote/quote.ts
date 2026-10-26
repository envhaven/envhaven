function needsQuoting(arg: string): boolean {
  if (arg.length === 0) return true;
  // A word that starts with `=` is expanded by zsh, the workspace login shell, to the path of the
  // command it names (`=key.pem` fails with "key.pem not found"), so it is quoted, though `=` is
  // safe elsewhere in a word. `~` is quoted wherever it appears, by the test below.
  if (arg.startsWith("=")) return true;
  return /[^a-zA-Z0-9_\-.,/:=@]/.test(arg);
}

export function posixQuote(arg: string): string {
  if (!needsQuoting(arg)) {
    return arg;
  }
  // Single-quote escaping: 'foo'\''bar' → foo'bar
  return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

export function posixQuoteArgs(args: readonly string[]): string {
  return args.map(posixQuote).join(" ");
}

export function buildRemoteCommand(cwd: string, args: readonly string[]): string {
  const quotedCwd = posixQuote(cwd);
  const quotedArgs = posixQuoteArgs(args);
  return `mkdir -p ${quotedCwd} && cd ${quotedCwd} && ${quotedArgs}`;
}
