// Text that came from the remote side (ssh's stderr, which carries the server's banner, and
// mutagen's errors, which carry remote file names) is printed inside the CLI's own messages.
// A workspace that controls that text could otherwise move the cursor, rewrite earlier lines,
// retitle the window or plant an OSC 8 hyperlink that reads as one thing and opens another.
// Raw passthrough of a remote command's own output (`haven npm start`) is the feature and is not
// filtered here, the same as plain `ssh`; this is only for strings the CLI embeds in its messages.

// ESC followed by: a CSI sequence, an OSC string (ended by BEL or ST), a DCS/SOS/PM/APC string
// (ended by ST), or any other escape (intermediate bytes, then one final byte, as in `ESC ( B`).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~])/g;

// Whatever is left of the C0 set except tab and newline (carriage return included, since it can
// overwrite the start of a line), DEL, and the C1 set, which some terminals honour as 8-bit
// equivalents of the escapes above.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function stripTerminalControl(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, "").replace(CONTROL_CHARACTER, "");
}
