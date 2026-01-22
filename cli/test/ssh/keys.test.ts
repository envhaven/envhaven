import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  findExistingKeys,
  getAllKeyPaths,
  getPublicKeys,
  hasExistingKeys,
  getHavenKeyPath,
  hasHavenKey,
  getHavenPublicKey,
  generateHavenKey,
  ensureKeyExists,
  isKeyEncrypted,
  getKeyFingerprint,
  analyzeKeys,
  hasUsableKey,
} from "../../src/ssh/keys";

const TEST_SSH_DIR = "/tmp/haven-test-ssh";

const MOCK_ED25519_PRIVATE = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBGTtfRcY8FdN0rmMXJqK0LJGxPkTj5WDZ3XJ6A0x3q6wAAAJCqmz+Cqps/
ggAAAAtzc2gtZWQyNTUxOQAAACBGTtfRcY8FdN0rmMXJqK0LJGxPkTj5WDZ3XJ6A0x3q6w
AAAEBGTtfRcY8FdN0rmMXJqK0LJGxPkTj5WDZ3XJ6A0x3q60ZO19FxjwV03SuYxcmorQsk
bE+ROPlYNndcnoDTHerrAAAACXRlc3Qta2V5AQI=
-----END OPENSSH PRIVATE KEY-----`;

const MOCK_ED25519_PUBLIC = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEbO19FxjwV03SuYxcmorQskbE+ROPlYNndcnoDTHerr test-key";
const MOCK_RSA_PUBLIC = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDtest test-rsa-key";

function createMockKey(name: string, publicKey: string): void {
  writeFileSync(join(TEST_SSH_DIR, name), MOCK_ED25519_PRIVATE, { mode: 0o600 });
  writeFileSync(join(TEST_SSH_DIR, `${name}.pub`), publicKey, { mode: 0o644 });
}

async function createRealKey(name: string, passphrase: string = ""): Promise<void> {
  const keyPath = join(TEST_SSH_DIR, name);
  const proc = Bun.spawn([
    "ssh-keygen", "-t", "ed25519", "-f", keyPath,
    "-N", passphrase, "-C", `test-${name}`, "-q"
  ], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

describe("ssh/keys", () => {
  beforeEach(() => {
    if (existsSync(TEST_SSH_DIR)) {
      rmSync(TEST_SSH_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_SSH_DIR, { recursive: true, mode: 0o700 });
  });
  
  afterEach(() => {
    if (existsSync(TEST_SSH_DIR)) {
      rmSync(TEST_SSH_DIR, { recursive: true, force: true });
    }
  });
  
  describe("findExistingKeys", () => {
    it("returns empty array when no keys exist", () => {
      const keys = findExistingKeys(TEST_SSH_DIR);
      expect(keys).toEqual([]);
    });
    
    it("finds id_ed25519 key", () => {
      createMockKey("id_ed25519", MOCK_ED25519_PUBLIC);
      
      const keys = findExistingKeys(TEST_SSH_DIR);
      expect(keys).toHaveLength(1);
      expect(keys[0]!.privateKeyPath).toBe(`${TEST_SSH_DIR}/id_ed25519`);
      expect(keys[0]!.publicKeyPath).toBe(`${TEST_SSH_DIR}/id_ed25519.pub`);
      expect(keys[0]!.publicKey).toBe(MOCK_ED25519_PUBLIC);
    });
    
    it("finds id_rsa key", () => {
      createMockKey("id_rsa", MOCK_RSA_PUBLIC);
      
      const keys = findExistingKeys(TEST_SSH_DIR);
      expect(keys).toHaveLength(1);
      expect(keys[0]!.privateKeyPath).toBe(`${TEST_SSH_DIR}/id_rsa`);
    });
    
    it("finds haven_ed25519 key", () => {
      createMockKey("haven_ed25519", MOCK_ED25519_PUBLIC);
      
      const keys = findExistingKeys(TEST_SSH_DIR);
      expect(keys).toHaveLength(1);
      expect(keys[0]!.privateKeyPath).toBe(`${TEST_SSH_DIR}/haven_ed25519`);
    });
    
    it("finds multiple keys", () => {
      createMockKey("id_ed25519", MOCK_ED25519_PUBLIC);
      createMockKey("id_rsa", MOCK_RSA_PUBLIC);
      createMockKey("haven_ed25519", MOCK_ED25519_PUBLIC);
      
      const keys = findExistingKeys(TEST_SSH_DIR);
      expect(keys).toHaveLength(3);
    });
    
    it("ignores keys without public key file", () => {
      writeFileSync(join(TEST_SSH_DIR, "id_ed25519"), MOCK_ED25519_PRIVATE, { mode: 0o600 });
      
      const keys = findExistingKeys(TEST_SSH_DIR);
      expect(keys).toEqual([]);
    });
    
    it("ignores keys with empty public key", () => {
      writeFileSync(join(TEST_SSH_DIR, "id_ed25519"), MOCK_ED25519_PRIVATE, { mode: 0o600 });
      writeFileSync(join(TEST_SSH_DIR, "id_ed25519.pub"), "", { mode: 0o644 });
      
      const keys = findExistingKeys(TEST_SSH_DIR);
      expect(keys).toEqual([]);
    });
    
    it("ignores unknown key names", () => {
      createMockKey("my_custom_key", MOCK_ED25519_PUBLIC);
      
      const keys = findExistingKeys(TEST_SSH_DIR);
      expect(keys).toEqual([]);
    });
  });
  
  describe("getAllKeyPaths", () => {
    it("returns array of private key paths", () => {
      createMockKey("id_ed25519", MOCK_ED25519_PUBLIC);
      createMockKey("id_rsa", MOCK_RSA_PUBLIC);
      
      const paths = getAllKeyPaths(TEST_SSH_DIR);
      expect(paths).toHaveLength(2);
      expect(paths).toContain(`${TEST_SSH_DIR}/id_ed25519`);
      expect(paths).toContain(`${TEST_SSH_DIR}/id_rsa`);
    });
  });
  
  describe("getPublicKeys", () => {
    it("returns array of public key contents", () => {
      createMockKey("id_ed25519", MOCK_ED25519_PUBLIC);
      createMockKey("id_rsa", MOCK_RSA_PUBLIC);
      
      const keys = getPublicKeys(TEST_SSH_DIR);
      expect(keys).toHaveLength(2);
      expect(keys).toContain(MOCK_ED25519_PUBLIC);
      expect(keys).toContain(MOCK_RSA_PUBLIC);
    });
  });
  
  describe("hasExistingKeys", () => {
    it("returns false when no keys exist", () => {
      expect(hasExistingKeys(TEST_SSH_DIR)).toBe(false);
    });
    
    it("returns true when keys exist", () => {
      createMockKey("id_ed25519", MOCK_ED25519_PUBLIC);
      expect(hasExistingKeys(TEST_SSH_DIR)).toBe(true);
    });
  });
  
  describe("getHavenKeyPath", () => {
    it("returns correct path", () => {
      expect(getHavenKeyPath(TEST_SSH_DIR)).toBe(`${TEST_SSH_DIR}/haven_ed25519`);
    });
  });
  
  describe("hasHavenKey", () => {
    it("returns false when haven key does not exist", () => {
      expect(hasHavenKey(TEST_SSH_DIR)).toBe(false);
    });
    
    it("returns true when both private and public haven key exist", () => {
      createMockKey("haven_ed25519", MOCK_ED25519_PUBLIC);
      expect(hasHavenKey(TEST_SSH_DIR)).toBe(true);
    });
    
    it("returns false when only private key exists", () => {
      writeFileSync(join(TEST_SSH_DIR, "haven_ed25519"), MOCK_ED25519_PRIVATE, { mode: 0o600 });
      expect(hasHavenKey(TEST_SSH_DIR)).toBe(false);
    });
    
    it("returns false when only public key exists", () => {
      writeFileSync(join(TEST_SSH_DIR, "haven_ed25519.pub"), MOCK_ED25519_PUBLIC, { mode: 0o644 });
      expect(hasHavenKey(TEST_SSH_DIR)).toBe(false);
    });
    
    it("returns true even if other keys exist", () => {
      createMockKey("id_ed25519", MOCK_ED25519_PUBLIC);
      createMockKey("haven_ed25519", MOCK_ED25519_PUBLIC);
      expect(hasHavenKey(TEST_SSH_DIR)).toBe(true);
    });
  });
  
  describe("getHavenPublicKey", () => {
    it("returns null when haven key does not exist", () => {
      expect(getHavenPublicKey(TEST_SSH_DIR)).toBeNull();
    });
    
    it("returns public key content when haven key exists", () => {
      createMockKey("haven_ed25519", MOCK_ED25519_PUBLIC);
      expect(getHavenPublicKey(TEST_SSH_DIR)).toBe(MOCK_ED25519_PUBLIC);
    });
    
    it("trims whitespace from public key", () => {
      writeFileSync(join(TEST_SSH_DIR, "haven_ed25519"), MOCK_ED25519_PRIVATE, { mode: 0o600 });
      writeFileSync(join(TEST_SSH_DIR, "haven_ed25519.pub"), `  ${MOCK_ED25519_PUBLIC}  \n`, { mode: 0o644 });
      expect(getHavenPublicKey(TEST_SSH_DIR)).toBe(MOCK_ED25519_PUBLIC);
    });
  });
  
  describe("generateHavenKey", () => {
    it("generates a new haven key", async () => {
      const result = await generateHavenKey(TEST_SSH_DIR);
      
      expect(result.privateKeyPath).toBe(`${TEST_SSH_DIR}/haven_ed25519`);
      expect(result.publicKeyPath).toBe(`${TEST_SSH_DIR}/haven_ed25519.pub`);
      expect(result.publicKey).toContain("ssh-ed25519");
      expect(result.publicKey).toContain("haven-cli");
      
      expect(existsSync(result.privateKeyPath)).toBe(true);
      expect(existsSync(result.publicKeyPath)).toBe(true);
    });
    
    it("creates ssh directory if it does not exist", async () => {
      const newDir = `${TEST_SSH_DIR}/nested/ssh`;
      rmSync(TEST_SSH_DIR, { recursive: true, force: true });
      
      await generateHavenKey(newDir);
      
      expect(existsSync(newDir)).toBe(true);
      expect(existsSync(`${newDir}/haven_ed25519`)).toBe(true);
    });
  });
  
  describe("ensureKeyExists", () => {
    it("returns existing keys without generating", async () => {
      createMockKey("id_ed25519", MOCK_ED25519_PUBLIC);
      
      const result = await ensureKeyExists(TEST_SSH_DIR);
      
      expect(result.generated).toBe(false);
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0]!.publicKey).toBe(MOCK_ED25519_PUBLIC);
      expect(existsSync(`${TEST_SSH_DIR}/haven_ed25519`)).toBe(false);
    });
    
    it("generates haven key when no keys exist", async () => {
      const result = await ensureKeyExists(TEST_SSH_DIR);
      
      expect(result.generated).toBe(true);
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0]!.privateKeyPath).toBe(`${TEST_SSH_DIR}/haven_ed25519`);
      expect(result.keys[0]!.publicKey).toContain("ssh-ed25519");
    });
  });

  describe("isKeyEncrypted", () => {
    it("returns false for unencrypted key", async () => {
      await createRealKey("id_ed25519", "");
      expect(await isKeyEncrypted(`${TEST_SSH_DIR}/id_ed25519`)).toBe(false);
    });

    it("returns true for encrypted key", async () => {
      await createRealKey("encrypted_key", "testpassphrase");
      expect(await isKeyEncrypted(`${TEST_SSH_DIR}/encrypted_key`)).toBe(true);
    });

    it("returns false for haven-generated key", async () => {
      const key = await generateHavenKey(TEST_SSH_DIR);
      expect(await isKeyEncrypted(key.privateKeyPath)).toBe(false);
    });
  });

  describe("getKeyFingerprint", () => {
    it("returns fingerprint for valid key", async () => {
      createMockKey("id_ed25519", MOCK_ED25519_PUBLIC);
      const fingerprint = await getKeyFingerprint(`${TEST_SSH_DIR}/id_ed25519`);
      expect(fingerprint).not.toBeNull();
      expect(fingerprint).toMatch(/^SHA256:/);
    });

    it("returns null for nonexistent key", async () => {
      const fingerprint = await getKeyFingerprint(`${TEST_SSH_DIR}/nonexistent`);
      expect(fingerprint).toBeNull();
    });
  });

  describe("analyzeKeys", () => {
    it("marks unencrypted key as usable", async () => {
      await createRealKey("id_ed25519", "");

      const analyses = await analyzeKeys(TEST_SSH_DIR);

      expect(analyses).toHaveLength(1);
      expect(analyses[0]!.encrypted).toBe(false);
      expect(analyses[0]!.usable).toBe(true);
    });

    it("marks encrypted key without agent as not usable", async () => {
      await createRealKey("id_ed25519", "testpassphrase");

      const analyses = await analyzeKeys(TEST_SSH_DIR);

      expect(analyses).toHaveLength(1);
      expect(analyses[0]!.encrypted).toBe(true);
      expect(analyses[0]!.inAgent).toBe(false);
      expect(analyses[0]!.usable).toBe(false);
    });

    it("analyzes multiple unencrypted keys correctly", async () => {
      await createRealKey("id_ed25519", "");
      await createRealKey("id_rsa", "");

      const analyses = await analyzeKeys(TEST_SSH_DIR);

      expect(analyses).toHaveLength(2);
      expect(analyses.every(a => a.usable)).toBe(true);
    });
  });

  describe("hasUsableKey", () => {
    it("returns true when haven key exists", async () => {
      await createRealKey("haven_ed25519", "");
      expect(await hasUsableKey(TEST_SSH_DIR)).toBe(true);
    });

    it("returns true when unencrypted key exists", async () => {
      await createRealKey("id_ed25519", "");
      expect(await hasUsableKey(TEST_SSH_DIR)).toBe(true);
    });

    it("returns false when only encrypted keys exist without agent", async () => {
      await createRealKey("id_ed25519", "testpassphrase");
      expect(await hasUsableKey(TEST_SSH_DIR)).toBe(false);
    });

    it("returns true when mixed keys exist with at least one usable", async () => {
      await createRealKey("id_rsa", "");
      await createRealKey("id_ed25519", "testpassphrase");
      expect(await hasUsableKey(TEST_SSH_DIR)).toBe(true);
    });

    it("returns false when no keys exist", async () => {
      expect(await hasUsableKey(TEST_SSH_DIR)).toBe(false);
    });
  });
});
