#!/usr/bin/env bash
# Resilient bridge supervisor. Ignores SIGINT so the user can Ctrl-C the
# inner Node process to force a restart while the wrapper keeps looping.
# To fully stop, kill the tmux pane (or `kill -TERM` this PID).
#
# Back-off doubles after each crash up to a 60s cap so a config-broken
# bridge doesn't burn cycles in a 2s tight loop until the operator notices.
# Resets to 2s after any run that survived past WIN_FOR_SUCCESS_S.

set -u
trap '' INT

LOG=/tmp/wa-claude.log
umask 077
touch "$LOG"
chmod 600 "$LOG"

# Prefer bun; fall back to pnpm then npm. All three run the same "start" script
# (tsx src/index.ts), so the process signature stays identical across them.
if command -v bun >/dev/null; then PKG=bun
elif command -v pnpm >/dev/null; then PKG=pnpm
else PKG=npm
fi

WAIT_S=2
MAX_WAIT_S=60
WIN_FOR_SUCCESS_S=30

while true; do
  ts=$(date -Is)
  start=$SECONDS
  echo "[$ts] [wrapper] starting bridge ($PKG)" | tee -a "$LOG"
  "$PKG" start 2>&1 | tee -a "$LOG"
  ec=${PIPESTATUS[0]}
  ran=$((SECONDS - start))
  ts=$(date -Is)
  if [ "$ran" -ge "$WIN_FOR_SUCCESS_S" ]; then WAIT_S=2; fi
  echo "[$ts] [wrapper] bridge exited code=$ec after ${ran}s, restarting in ${WAIT_S}s" | tee -a "$LOG"
  sleep "$WAIT_S"
  WAIT_S=$((WAIT_S * 2))
  [ "$WAIT_S" -gt "$MAX_WAIT_S" ] && WAIT_S=$MAX_WAIT_S
done
