#!/usr/bin/env bash
# Auto-attach to persistent tmux session

[[ $- != *i* ]] && return
[[ -n "$TMUX" ]] && return
[[ "${ENVHAVEN_SKIP_WELCOME:-}" == "1" ]] && return
command -v tmux &>/dev/null || return

SESSION="envhaven"

# Who should SEE the tmux status bar? Only clients with no other window UI:
#   - SSH sessions (sshd sets SSH_CONNECTION)
#   - the raw self-host console (the console server sets ENVHAVEN_CONSOLE_SESSION)
# The managed dashboard console (Cockpit) and code-server terminals fall through to
# the base session, where tmux.conf leaves the status bar off.
if [[ -n "${ENVHAVEN_CONSOLE_SESSION:-}" ]]; then
  VIEW="$ENVHAVEN_CONSOLE_SESSION"
elif [[ -n "${SSH_CONNECTION:-}" ]]; then
  VIEW="ssh-$$"
else
  VIEW=""
fi

# A grouped VIEW must never BE the base session: were ENVHAVEN_CONSOLE_SESSION ever
# "envhaven", the set-options below would flip the base bar on and self-destroy the
# shared session. Fall back to the base (no separate view) instead.
[[ "$VIEW" == "$SESSION" ]] && VIEW=""

# Base session (status off): the managed console + code-server attach here.
tmux has-session -t "$SESSION" 2>/dev/null || \
  tmux new-session -d -s "$SESSION" -c /config/workspace "zsh -c 'source ~/.zshrc 2>/dev/null; envhaven; exec zsh'"
[[ -z "$VIEW" ]] && exec tmux attach-session -t "$SESSION"

# Bar-showing client: attach a grouped session that SHARES the base windows but keeps
# its own status line (and its own current window). It self-destroys on disconnect so
# per-connection views never accumulate.
tmux has-session -t "$VIEW" 2>/dev/null || tmux new-session -d -t "$SESSION" -s "$VIEW"
tmux set-option -t "$VIEW" status 3
tmux set-option -t "$VIEW" destroy-unattached on
exec tmux attach-session -t "$VIEW"
