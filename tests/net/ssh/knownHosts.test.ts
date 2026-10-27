import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  judgeHostKey,
  keyFingerprint,
  lineMatchesName,
  parseKnownHosts,
  removeTrustedName,
  writeTrustedKey
} from '../../../src/mms/net/ssh/knownHosts'
import { KEY_A, KEY_B, KEY_RSA, fingerprint, hashedLine } from './bed'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'mousse kh '))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return {
    mousse: join(dir, 'mousse'),
    user: join(dir, 'user'),
    global: join(dir, 'global'),
    dir
  }
}
const offered = (key = KEY_A, name = 'box') => ({ name, type: key.type, key: key.key })
const line = (key: { type: string; key: string }, name = 'box') =>
  `${name} ${key.type} ${key.key}\n`

const hasKeygen = (() => {
  const result = spawnSync('ssh-keygen', ['-?'])
  return !result.error
})()

describe('matching', () => {
  it('matches plain names, patterns, bracketed ports and negations, and ignores certificate authorities', () => {
    const [a, b, c, d] = parseKnownHosts(
      [
        `*.example.com,!bad.example.com ${KEY_A.type} ${KEY_A.key}`,
        `[box]:2222 ${KEY_A.type} ${KEY_A.key}`,
        `@cert-authority * ${KEY_A.type} ${KEY_A.key}`,
        `@revoked box ${KEY_A.type} ${KEY_A.key}`
      ].join('\n')
    )
    expect(lineMatchesName(a!, 'good.example.com')).toBe(true)
    expect(lineMatchesName(a!, 'bad.example.com')).toBe(false)
    expect(lineMatchesName(b!, '[box]:2222')).toBe(true)
    expect(lineMatchesName(b!, 'box')).toBe(false)
    expect(lineMatchesName(c!, 'anything')).toBe(false)
    expect(d!.marker).toBe('@revoked')
  })

  it('finds a hashed entry and rejects another name', () => {
    const [entry] = parseKnownHosts(hashedLine('box', KEY_A))
    expect(lineMatchesName(entry!, 'box')).toBe(true)
    expect(lineMatchesName(entry!, 'other')).toBe(false)
  })

  it.skipIf(!hasKeygen)(
    'finds an entry hashed by the real ssh-keygen as trusted, changed and revoked',
    async () => {
      const s = await scratch()
      const generated = join(s.dir, 'key')
      expect(
        spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', generated]).status
      ).toBe(0)
      const [type, key] = (await readFile(generated + '.pub', 'utf8')).trim().split(' ')
      const real = { type: type!, key: key! }
      await writeFile(s.user, `box ${real.type} ${real.key}\n`)
      expect(spawnSync('ssh-keygen', ['-H', '-f', s.user]).status).toBe(0)
      expect((await readFile(s.user, 'utf8')).startsWith('|1|')).toBe(true)
      const files = { mousse: s.mousse, user: s.user, global: [] as string[] }
      expect((await judgeHostKey({ name: 'box', ...real }, files)).state).toBe('trusted')
      const other = { type: real.type, key: KEY_B.key }
      expect((await judgeHostKey({ name: 'box', ...other }, files)).state).toBe('changed')
      await writeFile(s.global, `@revoked box ${other.type} ${other.key}\n`)
      expect(
        (await judgeHostKey({ name: 'box', ...other }, { ...files, global: [s.global] })).state
      ).toBe('revoked')
    }
  )
})

describe('judging a host key', () => {
  it('trusts a key in any file, and tells the Mousse file apart from the others', async () => {
    const s = await scratch()
    const files = { mousse: s.mousse, user: s.user, global: [s.global] }
    expect((await judgeHostKey(offered(), files)).state).toBe('unknown')
    await writeFile(s.global, line(KEY_A))
    expect((await judgeHostKey(offered(), files)).state).toBe('trusted')
  })

  it('a missing global or user file is no match, never an error', async () => {
    const s = await scratch()
    expect(
      await judgeHostKey(offered(), { mousse: s.mousse, user: s.user, global: ['/nonexistent/x'] })
    ).toEqual({ state: 'unknown' })
  })

  it('a different algorithm is not a change', async () => {
    const s = await scratch()
    await writeFile(s.user, line(KEY_RSA))
    expect(await judgeHostKey(offered(), { mousse: s.mousse, user: s.user, global: [] })).toEqual({
      state: 'unknown',
      knownByOtherTypes: ['ssh-rsa']
    })
  })

  it('a conflicting key in a global file is changed with that file, and stale once Mousse holds the new one', async () => {
    const s = await scratch()
    await writeFile(s.global, line(KEY_B))
    const files = { mousse: s.mousse, user: s.user, global: [s.global] }
    expect(await judgeHostKey(offered(), files)).toMatchObject({
      state: 'changed',
      changed: { file: s.global, previousFingerprint: fingerprint(KEY_B) }
    })
    await writeFile(s.mousse, line(KEY_A))
    expect(await judgeHostKey(offered(), files)).toEqual({
      state: 'trusted',
      stale: [{ file: s.global, previousFingerprint: fingerprint(KEY_B) }]
    })
    // Never edited.
    expect(await readFile(s.global, 'utf8')).toBe(line(KEY_B))
  })

  it('a stale Mousse line with the new key already in the user file is changed from the Mousse file', async () => {
    const s = await scratch()
    await writeFile(s.mousse, line(KEY_B))
    await writeFile(s.user, line(KEY_A))
    expect(
      await judgeHostKey(offered(), { mousse: s.mousse, user: s.user, global: [] })
    ).toMatchObject({
      state: 'changed',
      changed: { file: s.mousse }
    })
  })

  it('computes OpenSSH fingerprints', () => {
    expect(keyFingerprint(KEY_A.key)).toBe(fingerprint(KEY_A))
    expect(keyFingerprint(KEY_A.key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })
})

describe('writing Mousse’s file', () => {
  it('appends once, replaces only the same type for the same host and leaves everything else', async () => {
    const s = await scratch()
    await writeFile(
      s.mousse,
      [
        line(KEY_B),
        line(KEY_RSA),
        line(KEY_B, 'other'),
        `@revoked box ssh-ed25519 AAAAB3NzaC1yc2E=`,
        ''
      ].join('')
    )
    expect(await writeTrustedKey(s.mousse, offered(), true)).toBe('replaced')
    const text = await readFile(s.mousse, 'utf8')
    expect(text).toContain(line(KEY_A))
    expect(text).toContain(line(KEY_RSA))
    expect(text).toContain(line(KEY_B, 'other'))
    expect(text).toContain('@revoked box')
    expect(text).not.toContain(line(KEY_B))
    expect(await writeTrustedKey(s.mousse, offered(), true)).toBe('present')
    expect(existsSync(s.mousse + '.old')).toBe(false)
  })

  it('removes the lines of one host name only', async () => {
    const s = await scratch()
    await writeFile(s.mousse, line(KEY_A) + line(KEY_RSA) + line(KEY_A, 'other'))
    await removeTrustedName(s.mousse, 'box')
    expect(await readFile(s.mousse, 'utf8')).toBe(line(KEY_A, 'other'))
  })
})
