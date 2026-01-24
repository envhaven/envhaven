import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkAuth, type ToolDefinition } from '../environment';

const originalEnv = { ...process.env };

function createToolDef(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    id: 'test-tool',
    name: 'Test Tool',
    command: 'test',
    description: 'Test tool',
    docsUrl: 'https://test.com',
    ...overrides,
  };
}

describe('checkAuth', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('env var detection', () => {
    it('returns ready when envVar is set', async () => {
      process.env.TEST_API_KEY = 'test-key';
      const def = createToolDef({ envVars: ['TEST_API_KEY'] });

      const result = await checkAuth(def);

      expect(result.status).toBe('ready');
      expect(result.connectedVia).toBe('TEST_API_KEY');
    });

    it('returns needs-auth when envVar is not set', async () => {
      const def = createToolDef({ envVars: ['NONEXISTENT_KEY'] });

      const result = await checkAuth(def);

      expect(result.status).toBe('needs-auth');
      expect(result.connectedVia).toBeNull();
    });

    it('prioritizes envVar over file-based auth', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const def = createToolDef({
        id: 'claude',
        envVars: ['ANTHROPIC_API_KEY'],
      });

      const result = await checkAuth(def);

      expect(result.status).toBe('ready');
      expect(result.connectedVia).toBe('ANTHROPIC_API_KEY');
    });
  });

  describe('file-based detection', () => {
    it('returns ready for OpenCode when auth.json exists', async () => {
      const authPath = path.join(os.homedir(), '.local/share/opencode/auth.json');
      const def = createToolDef({ id: 'opencode' });
      const result = await checkAuth(def);

      if (fs.existsSync(authPath)) {
        const content = fs.readFileSync(authPath, 'utf-8').trim();
        if (content && content !== '{}' && content !== '[]') {
          expect(result.status).toBe('ready');
          expect(result.connectedVia).toBe('opencode auth');
        } else {
          expect(result.status).toBe('needs-auth');
        }
      } else {
        expect(result.status).toBe('needs-auth');
      }
    });

    it('returns ready for Claude when credentials file exists', async () => {
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const def = createToolDef({ id: 'claude' });
      const result = await checkAuth(def);

      if (fs.existsSync(credPath)) {
        const content = fs.readFileSync(credPath, 'utf-8').trim();
        if (content && content !== '{}' && content !== '[]') {
          expect(result.status).toBe('ready');
          expect(result.connectedVia).toBe('credentials file');
        } else {
          expect(result.status).toBe('needs-auth');
        }
      } else {
        expect(result.status).toBe('needs-auth');
      }
    });

    it('returns unknown for Auggie without AUGMENT_SESSION_AUTH env var', async () => {
      delete process.env.AUGMENT_SESSION_AUTH;
      const def = createToolDef({ id: 'auggie' });
      const result = await checkAuth(def);

      expect(result.status).toBe('unknown');
      expect(result.connectedVia).toBeNull();
    });

    it('returns ready for Auggie with AUGMENT_SESSION_AUTH env var', async () => {
      process.env.AUGMENT_SESSION_AUTH = 'test-session-token';
      const def = createToolDef({ id: 'auggie' });
      const result = await checkAuth(def);

      expect(result.status).toBe('ready');
      expect(result.connectedVia).toBe('AUGMENT_SESSION_AUTH');
    });

    it('returns ready for Goose when config.yaml has GOOSE_PROVIDER', async () => {
      const configPath = path.join(os.homedir(), '.config/goose/config.yaml');
      const def = createToolDef({ id: 'goose' });
      const result = await checkAuth(def);

      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        if (content.includes('GOOSE_PROVIDER:')) {
          expect(result.status).toBe('ready');
          expect(result.connectedVia).toMatch(/^goose \(/);
        } else {
          expect(result.status).toBe('needs-auth');
        }
      } else {
        expect(result.status).toBe('needs-auth');
      }
    });

    it('returns needs-auth for Kiro when no settings exist', async () => {
      const kiroPath = path.join(os.homedir(), '.kiro/settings/cli.json');
      const def = createToolDef({ id: 'kiro' });
      const result = await checkAuth(def);

      if (!fs.existsSync(kiroPath)) {
        expect(result.status).toBe('needs-auth');
        expect(result.connectedVia).toBeNull();
      }
    });
  });

  describe('unknown tools', () => {
    it('returns unknown for tools with no detection method', async () => {
      const def = createToolDef({ id: 'unknown-tool' });

      const result = await checkAuth(def);

      expect(result.status).toBe('unknown');
      expect(result.connectedVia).toBeNull();
    });
  });
});
