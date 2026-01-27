import { describe, it, expect } from "bun:test";
import { generateHostConfig } from "../../src/ssh/config";

describe("generateHostConfig", () => {
  it("generates valid SSH config", () => {
    const config = generateHostConfig("haven-abc123", "myhost.com", 2222, "abc");
    
    expect(config).toContain("Host haven-abc123");
    expect(config).toContain("HostName myhost.com");
    expect(config).toContain("Port 2222");
    expect(config).toContain("User abc");
    expect(config).toContain("ServerAliveInterval 5");
  });

  it("includes security settings", () => {
    const config = generateHostConfig("haven-test", "host.com", 22, "user");
    
    expect(config).toContain("ForwardAgent no");
    expect(config).toContain("ForwardX11 no");
  });
});
