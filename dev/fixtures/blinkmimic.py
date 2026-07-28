#!/usr/bin/env python3
"""Minimal instrument for the blinking-cursor background question.

Paints one wide band in its OWN background colour (palette 236) and parks the
real cursor in the middle of it, then sits still. Nothing else on the row. So
whatever colour that cell shows is xterm's cursor rendering and nothing else,
and the off beat of the blink is directly observable.
"""
import os, sys, termios, tty, time

fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
cols, rows = os.get_terminal_size(fd)
BG, RS = '\x1b[48;5;236m', '\x1b[0m'
try:
    # setcbreak, not setraw. Both clear ECHO and ICANON, which is all this needs so a
    # keystroke is never echoed into the band. setraw also clears ISIG, and since nothing
    # here reads stdin, ^C then arrived as a byte nobody was listening for: the fixture
    # could not be killed, teardownApp silently failed, and the pane stayed occupied for
    # whatever ran next. The `except KeyboardInterrupt` below was unreachable.
    tty.setcbreak(fd)
    sys.stdout.write('\x1b[2J\x1b[H')
    row = rows // 2
    # A band the full width of the pane, in the app's own background.
    sys.stdout.write('\x1b[%d;1H%s%s%s' % (row, BG, ' ' * (cols - 1), RS))
    # Park the cursor well inside the band.
    sys.stdout.write('\x1b[%d;%dH' % (row, cols // 2))
    sys.stdout.flush()
    while True:
        time.sleep(0.2)
except KeyboardInterrupt:
    pass
finally:
    # Leave the pane as it was found. Every composer fixture clears on the way out;
    # this one used to leave its band painted for the next check to puzzle over.
    sys.stdout.write('\x1b[2J\x1b[H')
    sys.stdout.flush()
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
