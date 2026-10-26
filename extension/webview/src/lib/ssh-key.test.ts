import { describe, expect, test } from 'bun:test';
import { sshKeyToSend } from './ssh-key';

// One line of each key type the host's isAuthorizedKeyLine accepts, each with a comment.
// Secretive and other Secure Enclave agents hold ECDSA keys, and a hardware security key is
// an `sk-` key; `haven connect` prints whichever the user has and sends them to this box.
const KEYS = [
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop',
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 me@laptop',
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY secretive@mac',
  'ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQ me@laptop',
  'ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjE me@laptop',
  'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t yubikey',
  'sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20 yubikey',
];

describe('sshKeyToSend', () => {
  test('sends every key type the host accepts, as pasted', () => {
    for (const key of KEYS) {
      expect(sshKeyToSend(`  ${key}\n`)).toBe(key);
    }
  });

  test('leaves judging the line to the host, which says what is wrong with it', () => {
    expect(sshKeyToSend('not a key')).toBe('not a key');
  });

  test('sends nothing from an empty box', () => {
    expect(sshKeyToSend('')).toBeNull();
    expect(sshKeyToSend(' \n\t')).toBeNull();
  });
});
