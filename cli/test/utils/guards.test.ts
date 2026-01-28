import { describe, it, expect } from "bun:test";
import { homedir } from "os";
import {
  isSuspiciousPath,
  getSuspiciousPaths,
  getSuspiciousNames,
} from "../../src/utils/guards";

describe("isSuspiciousPath", () => {
  describe("system paths", () => {
    it("flags root directory", () => {
      expect(isSuspiciousPath("/")).toBe(true);
    });

    it("flags home directory", () => {
      expect(isSuspiciousPath(homedir())).toBe(true);
    });

    it("flags common home subdirectories", () => {
      expect(isSuspiciousPath(`${homedir()}/Documents`)).toBe(true);
      expect(isSuspiciousPath(`${homedir()}/Downloads`)).toBe(true);
      expect(isSuspiciousPath(`${homedir()}/Desktop`)).toBe(true);
    });

    it("flags system directories", () => {
      expect(isSuspiciousPath("/etc")).toBe(true);
      expect(isSuspiciousPath("/var")).toBe(true);
      expect(isSuspiciousPath("/usr")).toBe(true);
      expect(isSuspiciousPath("/bin")).toBe(true);
      expect(isSuspiciousPath("/tmp")).toBe(true);
    });

    it("flags macOS system directories", () => {
      expect(isSuspiciousPath("/System")).toBe(true);
      expect(isSuspiciousPath("/Applications")).toBe(true);
      expect(isSuspiciousPath(`${homedir()}/Library`)).toBe(true);
    });
  });

  describe("suspicious directory names", () => {
    it("flags node_modules anywhere", () => {
      expect(isSuspiciousPath("/some/path/node_modules")).toBe(true);
      expect(isSuspiciousPath(`${homedir()}/projects/myapp/node_modules`)).toBe(true);
    });

    it("flags .git directory", () => {
      expect(isSuspiciousPath("/some/repo/.git")).toBe(true);
    });

    it("flags Python virtual environments", () => {
      expect(isSuspiciousPath("/project/venv")).toBe(true);
      expect(isSuspiciousPath("/project/.venv")).toBe(true);
    });

    it("flags other dependency/build directories", () => {
      expect(isSuspiciousPath("/project/vendor")).toBe(true);
      expect(isSuspiciousPath("/project/__pycache__")).toBe(true);
      expect(isSuspiciousPath("/project/dist")).toBe(true);
      expect(isSuspiciousPath("/project/build")).toBe(true);
    });
  });

  describe("valid project paths", () => {
    it("allows normal project directories", () => {
      expect(isSuspiciousPath(`${homedir()}/projects/myapp`)).toBe(false);
      expect(isSuspiciousPath("/home/user/code/backend")).toBe(false);
      expect(isSuspiciousPath("/Users/dev/workspace/api")).toBe(false);
    });

    it("allows paths containing suspicious names as substrings", () => {
      expect(isSuspiciousPath("/projects/my-dist-system")).toBe(false);
      expect(isSuspiciousPath("/projects/build-tools")).toBe(false);
      expect(isSuspiciousPath("/projects/vendor-api")).toBe(false);
    });
  });
});

describe("getSuspiciousPaths", () => {
  it("returns a read-only set", () => {
    const paths = getSuspiciousPaths();
    expect(paths).toBeInstanceOf(Set);
    expect(paths.has("/")).toBe(true);
    expect(paths.has(homedir())).toBe(true);
  });
});

describe("getSuspiciousNames", () => {
  it("returns a read-only set", () => {
    const names = getSuspiciousNames();
    expect(names).toBeInstanceOf(Set);
    expect(names.has("node_modules")).toBe(true);
    expect(names.has(".git")).toBe(true);
  });
});
