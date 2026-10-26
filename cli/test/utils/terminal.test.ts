import { describe, it, expect } from "bun:test";
import { stripTerminalControl } from "../../src/utils/terminal";

describe("stripTerminalControl (L-12)", () => {
  it("removes colour and cursor sequences", () => {
    expect(stripTerminalControl("\x1b[31mred\x1b[0m \x1b[2J\x1b[Hdone")).toBe("red done");
  });

  it("removes an OSC 8 hyperlink but keeps its visible text", () => {
    const link = "\x1b]8;;https://evil.invalid\x1b\\click here\x1b]8;;\x1b\\";
    expect(stripTerminalControl(link)).toBe("click here");
  });

  it("removes window-title and BEL-terminated OSC strings", () => {
    expect(stripTerminalControl("a\x1b]0;pwned\x07b")).toBe("ab");
  });

  it("removes carriage returns that would overwrite the line", () => {
    expect(stripTerminalControl("Permission denied\rAll good")).toBe("Permission deniedAll good");
  });

  it("removes C1 controls and charset designations", () => {
    expect(stripTerminalControl("x\u009b31my\x1b(Bz")).toBe("x31myz");
  });

  it("keeps newlines, tabs and ordinary text", () => {
    expect(stripTerminalControl("line one\n\tline two ✓ ünïcödé")).toBe("line one\n\tline two ✓ ünïcödé");
  });
});
