import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'envhaven-version-check-'))
const curl = join(root, 'curl')
const status = join(root, 'status')
const script = resolve(import.meta.dir, '../../runtime/scripts/envhaven-version-check')
writeFileSync(curl, '#!/bin/sh\nprintf \'%s\' "$FAKE_RESPONSE"\n')
chmodSync(curl, 0o755)

afterAll(() => rmSync(root, { recursive: true, force: true }))

async function check(response: unknown, current = 'v1.7.9'): Promise<string> {
  const child = Bun.spawn(['bash', script], {
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      ENVHAVEN_MANAGED: 'true',
      ENVHAVEN_VERSION: current,
      ENVHAVEN_VERSION_STATUS_FILE: status,
      _ENVHAVEN_API_URL: 'https://api.example.test',
      FAKE_RESPONSE: JSON.stringify(response),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  expect(await child.exited).toBe(0)
  return readFileSync(status, 'utf8').trim()
}

describe('managed version status', () => {
  const digest = `sha256:${'a'.repeat(64)}`

  test('shows a release only when version, digest, and reference are one immutable object', async () => {
    expect(await check({
      latest: 'v1.8.0',
      latestDigest: digest,
      imageReference: `ghcr.io/envhaven/envhaven@${digest}`,
    })).toBe('v1.7.9 ⚡ v1.8.0 available')
  })

  test('fails closed for legacy and mismatched managed responses', async () => {
    expect(await check({ latest: 'v1.8.0' })).toBe('v1.7.9')
    expect(await check({
      latest: 'v1.8.0',
      latestDigest: digest,
      imageReference: `ghcr.io/envhaven/envhaven@sha256:${'b'.repeat(64)}`,
    })).toBe('v1.7.9')
  })

  test('never presents a release update to a development image', async () => {
    expect(await check({
      latest: 'v1.8.0',
      latestDigest: digest,
      imageReference: `ghcr.io/envhaven/envhaven@${digest}`,
    }, 'dev-local')).toBe('dev-local')
  })

  const announce = (latest: string) => ({
    latest,
    latestDigest: digest,
    imageReference: `ghcr.io/envhaven/envhaven@${digest}`,
  })

  test('never presents an older announcement as an update', async () => {
    expect(await check(announce('v1.8.0'), 'v1.8.2')).toBe('v1.8.2')
  })

  test('never updates to or from a prerelease', async () => {
    expect(await check(announce('v1.8.0'), 'v1.8.0-rc.1')).toBe('v1.8.0-rc.1')
    expect(await check(announce('v1.9.0-rc.1'), 'v1.8.0')).toBe('v1.8.0')
  })

  test('compares release components as numbers', async () => {
    expect(await check(announce('1.10.0'), '1.9.9')).toBe('1.9.9 ⚡ 1.10.0 available')
  })
})
