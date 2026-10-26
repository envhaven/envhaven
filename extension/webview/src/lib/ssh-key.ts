/**
 * The line the SSH key box sends to the extension host, or null when there is nothing to
 * send. It judges nothing about the key: the host checks every line (isAuthorizedKeyLine in
 * src/sidebar-provider.ts), accepts each key type sshd does, ECDSA and security-key (`sk-`)
 * keys among them, and names what is wrong with a line it refuses. A check here that knew
 * fewer types would turn those keys away silently, behind a disabled button.
 */
export function sshKeyToSend(value: string): string | null {
  return value.trim() || null;
}
