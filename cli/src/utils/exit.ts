const SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];

/**
 * Calls `cleanup` if the process ends before the returned function is called: a return or a throw
 * that reaches process.exit, Ctrl-C, a closed terminal, or a kill. Without a handler those signals
 * end the process at once and skip the "exit" event. With this one, the signal is raised again
 * once `cleanup` has run, so the process still dies of it: a shell stops a loop around a command
 * only when the command was killed by Ctrl-C, not when it exited with 130. `cleanup` runs during
 * exit, so it must be synchronous.
 */
export function cleanupOnExit(cleanup: () => void): () => void {
  const stop = () => {
    process.off("exit", cleanup);
    for (const signal of SIGNALS) process.off(signal, onSignal);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    stop();
    cleanup();
    process.kill(process.pid, signal);
  };
  process.on("exit", cleanup);
  for (const signal of SIGNALS) process.on(signal, onSignal);
  return stop;
}
