#!/usr/bin/env bash
# Auto-attach to persistent tmux session

[[ $- != *i* ]] && return
[[ -n "$TMUX" ]] && return
[[ "${ENVHAVEN_SKIP_WELCOME:-}" == "1" ]] && return
command -v tmux &>/dev/null || return

SESSION="envhaven"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach-session -t "$SESSION"
fi

exec tmux new-session -s "$SESSION" -c /config/workspace "zsh -c 'source ~/.zshrc 2>/dev/null; envhaven; exec zsh'"
