# robbyrussell, recolored to the EnvHaven palette. Same shape, glyphs, and
# weights as stock; only the hues change. 69/111 are the closest 256-color
# indexes to EnvHaven blue (#5A8AFF) and its lighter tint; no truecolor needed.
PROMPT="%(?:%{%B%F{69}%}➜ :%{%B%F{160}%}➜ )%{%b%f%} %{%F{111}%}%c%{%f%} \$(git_prompt_info)"
ZSH_THEME_GIT_PROMPT_PREFIX="%{%B%F{245}%}git:(%{%b%F{111}%}"
ZSH_THEME_GIT_PROMPT_SUFFIX="%{%f%} "
ZSH_THEME_GIT_PROMPT_DIRTY="%{%B%F{245}%})%{%b%} %{%F{214}%}✗"
ZSH_THEME_GIT_PROMPT_CLEAN="%{%B%F{245}%})%{%b%f%}"
