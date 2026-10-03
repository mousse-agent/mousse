import { createDecipheriv, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LegacyControlCredentials } from '../src/mms/profiles/migration/LegacyControlCredentials'
import { FIXTURE_CONTROL_CREDENTIALS } from '../src/shared/profiles'
import { writeOriginalControlCredentials } from './fixtures/agent-platform/migration-crash/legacyCredentials'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-legacy-credentials-'))
  roots.push(root)
  return root
}

describe('migration-only original Control credentials', () => {
  it('reads original independently generated AES bytes and writes bytes readable by the original format', () => {
    const root = home(), credentials = { ...FIXTURE_CONTROL_CREDENTIALS }
    const original = writeOriginalControlCredentials(root, credentials)
    const codec = new LegacyControlCredentials(root)
    expect(codec.getCredentials()).toEqual(credentials)
    codec.saveCredentials(credentials)
    const encoded = readFileSync(join(root, 'control', 'credentials.enc'))
    expect(encoded.equals(original)).toBe(false)
    const key = createHash('sha256').update(`${userInfo().username}@${hostname()}:${join(root, 'control')}`).update(encoded.subarray(0, 16)).digest()
    const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(16, 28))
    decipher.setAuthTag(encoded.subarray(28, 44))
    expect(JSON.parse(Buffer.concat([decipher.update(encoded.subarray(44)), decipher.final()]).toString('utf8'))).toEqual(credentials)
    if (process.platform !== 'win32') expect(statSync(join(root, 'control', 'credentials.enc')).mode & 0o777).toBe(0o600)
  })

  it('denies truncated, tampered and byte-copied ciphertext without creating any identity', () => {
    const root = home(), original = writeOriginalControlCredentials(root, { ...FIXTURE_CONTROL_CREDENTIALS })
    const path = join(root, 'control', 'credentials.enc'), codec = new LegacyControlCredentials(root)
    for (const offset of [0, 16, 28, 44]) {
      const tampered = Buffer.from(original); tampered[offset] ^= 1
      writeFileSync(path, tampered)
      expect(codec.getCredentials()).toBeNull()
    }
    writeFileSync(path, original.subarray(0, 43))
    expect(codec.getCredentials()).toBeNull()
    const other = join(root, 'other')
    mkdirSync(join(other, 'control'), { recursive: true })
    writeFileSync(join(other, 'control', 'credentials.enc'), original)
    expect(new LegacyControlCredentials(other).getCredentials()).toBeNull()
    expect(() => readFileSync(join(root, 'control', 'identity.json'))).toThrow()
    expect(() => readFileSync(join(root, 'net', 'net.db'))).toThrow()
  })
})
