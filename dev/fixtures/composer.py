#!/usr/bin/env python3
"""Word-wrapping composer TUI mimic for predictive-echo e2e.

Reproduces the measured Claude Code composer contract exactly as the engine
sees it: raw mode (-icanon -echo), a '> ' prompt, greedy word-wrap at
cols-2 with 2-space continuation indent, bottom-anchored render (the block
grows upward, so on a wrap the cursor KEEPS its screen row while the first
line moves up), eager reflow on deletes, readline-style ^A/^E/^U/^W/M-b/M-f.
Exit with ^C.
"""
import os
import re
import sys
import termios
import tty

fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
cols, rows = os.get_terminal_size(fd)
W = cols - 2          # max rendered row length (measured: wrap keeps rows <= cols-2)
PROMPT, INDENT = '> ', '  '
buf, cur = '', 0
WORD = re.compile(r'[0-9A-Za-zÀ-ɏͰ-ϿЀ-ӿḀ-ỿ]')


def wrap(text):
    lines, line = [], PROMPT
    for word in text.split(' '):
        sep = '' if line in (PROMPT, INDENT) else ' '
        if len(line) + len(sep) + len(word) <= W:
            line = line + sep + word
        else:
            if line not in (PROMPT, INDENT):
                lines.append(line)
                line = INDENT
            while len(line) + len(word) > W:  # unbreakable word: hard split
                take = W - len(line)
                lines.append(line + word[:take])
                word, line = word[take:], INDENT
            line = line + word
    lines.append(line)
    return lines


def pos_of(idx):
    """(line, col) of buffer index idx in the wrapped layout."""
    lines = wrap(buf)
    consumed = 0
    for li, ln in enumerate(lines):
        pref = PROMPT if li == 0 else INDENT
        n = len(ln) - len(pref)
        extra = 1 if li + 1 < len(lines) else 0  # the space eaten by the wrap
        if idx <= consumed + n:
            return lines, li, len(pref) + (idx - consumed)
        consumed += n + extra
    return lines, len(lines) - 1, len(lines[-1])


last_top = rows
STATUS = '  \u23f5\u23f5 mimic status'  # symbol-led like the real composer's hint row


def render():
    global last_top
    lines, li, col = pos_of(cur)
    # Bottom-anchored like the real composer at a full screen: the block grows
    # UPWARD by repainting one row higher (no scroll; the cursor keeps both its
    # visual and absolute row) — measured on the real composer.
    top = rows - len(lines) - 1  # one status row below, like the composer's hint line
    clear_from = min(top, last_top)  # a shrinking block must erase its old top rows
    last_top = top
    out = (f'\x1b[{clear_from};1H\x1b[J' + f'\x1b[{top};1H' + '\r\n'.join(lines)
           + f'\x1b[{rows};1H{STATUS}' + f'\x1b[{top + li};{col + 1}H')
    sys.stdout.write(out)
    sys.stdout.flush()


def word_left(s, i):
    while i > 0 and not WORD.match(s[i - 1]):
        i -= 1
    while i > 0 and WORD.match(s[i - 1]):
        i -= 1
    return i


def word_right(s, i):
    while i < len(s) and WORD.match(s[i]):
        i += 1
    while i < len(s) and not WORD.match(s[i]):
        i += 1
    return i


try:
    tty.setraw(fd)
    sys.stdout.write('\x1b[2J')
    render()
    pending = b''
    while True:
        ch = os.read(fd, 64)
        if not ch:
            break
        pending += ch
        try:
            data = pending.decode()
            pending = b''
        except UnicodeDecodeError:
            continue
        i = 0
        while i < len(data):
            c = data[i]
            if c == '\x03':
                raise KeyboardInterrupt
            if c == '\x1b':
                seq = data[i:i + 3]
                if seq.startswith('\x1b\x7f') or seq.startswith('\x1b\x08'):
                    j = word_left(buf, cur)
                    buf, cur = buf[:j] + buf[cur:], j
                    i += 2
                elif seq[1:2] == 'b':
                    cur = word_left(buf, cur); i += 2
                elif seq[1:2] == 'f':
                    cur = word_right(buf, cur); i += 2
                elif seq[1:2] in ('[', 'O') and len(seq) >= 3:
                    k = seq[2]
                    if k == 'D':
                        cur = max(0, cur - 1)
                    elif k == 'C':
                        cur = min(len(buf), cur + 1)
                    i += 3
                else:
                    i += 1
            elif c == '\x7f' or c == '\x08':
                if cur > 0:
                    buf, cur = buf[:cur - 1] + buf[cur:], cur - 1
                i += 1
            elif c == '\x17':
                j = word_left(buf, cur)
                buf, cur = buf[:j] + buf[cur:], j
                i += 1
            elif c == '\x01':
                cur = 0; i += 1
            elif c == '\x05':
                cur = len(buf); i += 1
            elif c == '\x15':
                buf, cur = buf[cur:], 0
                i += 1
            elif c in ('\r', '\n'):
                buf, cur = '', 0
                i += 1
            elif c >= ' ':
                buf, cur = buf[:cur] + c + buf[cur:], cur + 1
                i += 1
            else:
                i += 1
        render()
except KeyboardInterrupt:
    pass
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
    sys.stdout.write('\x1b[2J\x1b[H')
    sys.stdout.flush()
