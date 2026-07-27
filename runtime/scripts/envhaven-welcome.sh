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
# The base has to actually be there before anything attaches to it or groups onto it, and
# the create above can fail (a missing /config/workspace, a zsh that dies on a broken
# rc). It matters most for the grouped path below: tmux's -t creates a NEW GROUP of that
# name when the target is missing, so the view would come up ungrouped, sharing nothing,
# and still armed with destroy-unattached — a shell that looks ordinary and takes the
# user's work with it when the tab closes. Nothing to attach to means we exec nothing:
# return and let the login land in a plain shell, which is the one outcome that always
# leaves a way back in.
tmux has-session -t "$SESSION" 2>/dev/null || return
[[ -z "$VIEW" ]] && exec tmux attach-session -t "$SESSION"

# Bar-showing client: attach a grouped session that SHARES the base windows but keeps
# its own status line (and its own current window). It self-destroys on disconnect so
# per-connection views never accumulate.
# ONE atomic server call, with both options landing AFTER the attach. Flipping
# destroy-unattached on a session that has no client yet destroys it on the spot, so
# the old create-then-set-then-attach order killed the view before anyone reached it —
# deterministically, on every first connect, not as a rare race. Because the attach is
# exec'd, that EOFs the console pty during what the user experiences as a refresh. -A
# closes the smaller window as well: it attaches the view when it exists and builds it
# grouped on the base when it does not, so a second tab cannot slip between a
# has-session check and the attach. Setting each option only ever ON keeps concurrent
# connects idempotent; a disarm/re-arm pair interleaves badly across two tabs and leaks
# the view (measured: it leaked).
#
# destroy-unattached is armed FIRST because tmux abandons the rest of a command list
# after an error: with the cosmetic option ahead of it, any tmux that rejects `status 3`
# would leave a view that is never swept — one leaked session per SSH login. The bar
# costs one SIGWINCH as it claims its rows (measured: 24 -> 21), a single repaint at
# connect, and the browser sends its own resize on socket open anyway.
exec tmux new-session -A -t "$SESSION" -s "$VIEW" \; \
  set-option -t "$VIEW" destroy-unattached on \; set-option -t "$VIEW" status 3
