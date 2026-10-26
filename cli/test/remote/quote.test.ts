import { describe, it, expect } from "bun:test";
import { posixQuote, posixQuoteArgs, buildRemoteCommand } from "../../src/remote/quote";

describe("posixQuote", () => {
  it("returns simple strings unchanged", () => {
    expect(posixQuote("hello")).toBe("hello");
    expect(posixQuote("foo-bar")).toBe("foo-bar");
    expect(posixQuote("foo_bar")).toBe("foo_bar");
    expect(posixQuote("foo.bar")).toBe("foo.bar");
    expect(posixQuote("/path/to/file")).toBe("/path/to/file");
    expect(posixQuote("user@host")).toBe("user@host");
    expect(posixQuote("key=value")).toBe("key=value");
  });

  it("quotes strings with spaces", () => {
    expect(posixQuote("hello world")).toBe("'hello world'");
    expect(posixQuote("foo bar baz")).toBe("'foo bar baz'");
  });

  it("quotes strings with special characters", () => {
    expect(posixQuote("$HOME")).toBe("'$HOME'");
    expect(posixQuote("foo;bar")).toBe("'foo;bar'");
    expect(posixQuote("foo|bar")).toBe("'foo|bar'");
    expect(posixQuote("foo&bar")).toBe("'foo&bar'");
    expect(posixQuote("foo<bar")).toBe("'foo<bar'");
    expect(posixQuote("foo>bar")).toBe("'foo>bar'");
  });

  it("escapes single quotes", () => {
    expect(posixQuote("it's")).toBe("'it'\"'\"'s'");
    expect(posixQuote("don't")).toBe("'don'\"'\"'t'");
  });

  it("quotes empty strings", () => {
    expect(posixQuote("")).toBe("''");
  });

  it("quotes words that zsh or any shell expands at their start", () => {
    expect(posixQuote("=key.pem")).toBe("'=key.pem'");
    expect(posixQuote("~/notes")).toBe("'~/notes'");
    expect(posixQuote("a=b")).toBe("a=b");
  });
});

describe("posixQuoteArgs", () => {
  it("joins quoted arguments", () => {
    expect(posixQuoteArgs(["echo", "hello", "world"])).toBe("echo hello world");
    expect(posixQuoteArgs(["echo", "hello world"])).toBe("echo 'hello world'");
  });
});

describe("buildRemoteCommand", () => {
  it("builds mkdir -p && cd && command", () => {
    expect(buildRemoteCommand("/home/user", ["ls", "-la"])).toBe("mkdir -p /home/user && cd /home/user && ls -la");
  });

  it("quotes paths with spaces", () => {
    expect(buildRemoteCommand("/home/my user", ["pwd"])).toBe("mkdir -p '/home/my user' && cd '/home/my user' && pwd");
  });

  it("quotes command arguments", () => {
    expect(buildRemoteCommand("/home/user", ["echo", "hello world"])).toBe("mkdir -p /home/user && cd /home/user && echo 'hello world'");
  });
});
