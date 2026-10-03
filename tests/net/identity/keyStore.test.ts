import { afterEach, describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore } from '../../../src/mms/net/identity/FileKeyStore'
import { decodeBase64, verifyBytes } from '../../../src/mms/net/identity/crypto'
import { newId } from '../../../src/shared/net/ids'
import type { SecretCodec } from '../../../src/mms/providers/secretCodec'

const directories: string[] = []
function profile(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-keys-'))); directories.push(dir); return dir }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const noVault: SecretCodec = { canEncrypt: () => false, encrypt: () => null, decrypt: () => null }
function vault() {
  const key = randomBytes(32)
  let available = true
  const codec: SecretCodec = {
    encryptionRequired: true, canEncrypt: () => available,
    encrypt: plain => {
      if (!available) return null
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
    },
    decrypt: bytes => {
      if (!available) return null
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16))
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString()
    }
  }
  return { codec, unavailable: () => { available = false }, available: () => { available = true } }
}

describe('FileKeyStore real key files and restart', () => {
  it('persists distinct keys, bot signatures, secrets and matching TLS credentials across reopening', async () => {
    const dir = profile(), keys = new FileKeyStore(dir, { codec: noVault })
    expect(keys.state()).toBe('missing')
    expect(() => keys.signAsNode(Buffer.from('x'))).toThrow(expect.objectContaining({ code: 'keystore_missing' }))
    const created = await keys.initialize({ asAuthority: true })
    const bot = newId('bot'), botKey = keys.createBotKey(bot), message = Buffer.from('signed exact bytes')
    keys.putSecret('__proto__', Buffer.from('private symmetric bytes'))
    const signature = keys.signAsNode(message)
    const reopened = new FileKeyStore(dir, { codec: noVault })
    expect(reopened.nodeKeys()).toEqual(created.node)
    expect(reopened.rootKey()).toBe(created.rootKey)
    verifyBytes(message, signature, created.node.sign)
    verifyBytes(message, reopened.signAsBot(bot, message), botKey)
    expect(Buffer.from(reopened.getSecret('__proto__')!).toString()).toBe('private symmetric bytes')
    expect(reopened.getSecret('toString')).toBeUndefined()
    expect(new X509Certificate(reopened.tlsCredentials().cert).publicKey.export({ type: 'spki', format: 'der' })).toEqual(decodeBase64(created.node.transport))
    if (process.platform !== 'win32') expect(statSync(join(dir, 'net', 'keys.json')).mode & 0o077).toBe(0)
    await expect(reopened.initialize({ asAuthority: false })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('locks a passphrase store after restart and rejects wrong passphrase without changing bytes', async () => {
    const dir = profile(), keys = new FileKeyStore(dir, { codec: noVault, passphrase: 'correct phrase' })
    await keys.initialize({ asAuthority: true }); keys.putSecret('canary', Buffer.from('super-private-canary'))
    const file = join(dir, 'net', 'keys.json'), before = readFileSync(file)
    expect(before.toString()).not.toContain('PRIVATE KEY'); expect(before.toString()).not.toContain('super-private-canary')
    const reopened = new FileKeyStore(dir, { codec: noVault })
    expect(reopened.state()).toBe('locked')
    await expect(reopened.unlock('wrong')).rejects.toMatchObject({ code: 'keystore_locked' })
    expect(readFileSync(file)).toEqual(before)
    await reopened.unlock('correct phrase')
    expect(reopened.nodeKeys()).toEqual(keys.nodeKeys())
    expect(Buffer.from(reopened.getSecret('canary')!).toString()).toBe('super-private-canary')
  })

  it('uses vault encoding and never falls back to plaintext when vault availability changes', async () => {
    const dir = profile(), storage = vault(), keys = new FileKeyStore(dir, { codec: storage.codec })
    await keys.initialize({ asAuthority: true }); keys.putSecret('canary', Buffer.from('vault-secret'))
    const file = join(dir, 'net', 'keys.json'), before = readFileSync(file)
    expect(JSON.parse(before.toString()).mode).toBe('vault'); expect(before.toString()).not.toContain('PRIVATE KEY')
    storage.unavailable()
    expect(() => keys.putSecret('new', Buffer.from('x'))).toThrow(expect.objectContaining({ code: 'keystore_locked' }))
    expect(readFileSync(file)).toEqual(before)
    const reopened = new FileKeyStore(dir, { codec: storage.codec }); expect(reopened.state()).toBe('locked')
    storage.available(); await reopened.unlock('')
    expect(reopened.nodeKeys()).toEqual(keys.nodeKeys())
    const unavailable = new FileKeyStore(profile(), { codec: { ...noVault, encryptionRequired: true } })
    await expect(unavailable.initialize({ asAuthority: true })).rejects.toMatchObject({ code: 'keystore_locked' })
    expect(unavailable.state()).toBe('missing')
  })

  it('authenticates encrypted recovery, preserves same root and does not replace another identity', async () => {
    const keys = new FileKeyStore(profile(), { codec: noVault }); await keys.initialize({ asAuthority: true })
    const file = await keys.exportRecovery('recovery passphrase')
    expect(Buffer.from(file).toString()).not.toContain('PRIVATE KEY')
    const targetDir = profile(), target = new FileKeyStore(targetDir, { codec: noVault }); await target.initialize({ asAuthority: false })
    await expect(target.importRecovery(file, 'wrong')).rejects.toMatchObject({ code: 'keystore_locked' }); expect(target.rootKey()).toBeUndefined()
    const tampered = Buffer.from(file), parsed = JSON.parse(tampered.toString()); const ct = Buffer.from(parsed.ct, 'base64url'); ct[0] ^= 1; parsed.ct = ct.toString('base64url')
    await expect(target.importRecovery(Buffer.from(JSON.stringify(parsed)), 'recovery passphrase')).rejects.toMatchObject({ code: 'keystore_locked' })
    await target.importRecovery(file, 'recovery passphrase'); expect(target.rootKey()).toBe(keys.rootKey())
    const other = new FileKeyStore(profile(), { codec: noVault }); await other.initialize({ asAuthority: true })
    await expect(other.importRecovery(file, 'recovery passphrase')).rejects.toMatchObject({ code: 'conflict' })
    target.dropRootKey(); expect(new FileKeyStore(targetDir, { codec: noVault }).rootKey()).toBeUndefined()
  })

  it('recovers an owner-bearing write lock after actual child SIGKILL', () => {
    const dir = profile(), executable = join(dir, 'keyStore-child.cjs')
    buildSync({ entryPoints: [fileURLToPath(new URL('./keyStore-child.ts', import.meta.url))], outfile: executable, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' })
    const child = spawnSync(process.execPath, [executable, dir, 'kill'], { timeout: 10000, encoding: 'utf8' })
    expect(child.signal, child.stderr).toBe('SIGKILL')
    const marker = JSON.parse(readFileSync(join(dir, 'net', 'keys.json.lock'), 'utf8'))
    expect(marker.pid).toBeGreaterThan(0); expect(marker.token).toMatch(/^[0-9a-f]{32}$/)
    const reopened = new FileKeyStore(dir, { codec: noVault })
    expect(reopened.getSecret('uncommitted')).toBeUndefined()
    reopened.putSecret('afterRestart', Buffer.from('durable'))
    expect(Buffer.from(new FileKeyStore(dir, { codec: noVault }).getSecret('afterRestart')!).toString()).toBe('durable')
  })

  it('never bypasses a live child owner, then recovers after its real SIGKILL', async () => {
    const dir = profile(), executable = join(dir, 'keyStore-child.cjs')
    buildSync({ entryPoints: [fileURLToPath(new URL('./keyStore-child.ts', import.meta.url))], outfile: executable, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' })
    const child = spawn(process.execPath, [executable, dir, 'hold'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    try {
      await Promise.race([once(child.stdout!, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('Child did not publish lock ownership.')), 3000))])
      const before = readFileSync(join(dir, 'net', 'keys.json')), marker = readFileSync(join(dir, 'net', 'keys.json.lock'))
      const contender = new FileKeyStore(dir, { codec: noVault })
      expect(() => contender.putSecret('liveOwnerBypass', Buffer.from('forbidden'))).toThrow(expect.objectContaining({ code: 'conflict' }))
      expect(readFileSync(join(dir, 'net', 'keys.json'))).toEqual(before)
      expect(readFileSync(join(dir, 'net', 'keys.json.lock'))).toEqual(marker)
    } finally { child.kill('SIGKILL'); await exited }
    const reopened = new FileKeyStore(dir, { codec: noVault }); reopened.putSecret('afterKill', Buffer.from('allowed'))
    expect(Buffer.from(reopened.getSecret('afterKill')!).toString()).toBe('allowed')
  })

  it('rejects symlinked key directory and stale concurrent writers, preserving the winner', async () => {
    const dir = profile(), keys = new FileKeyStore(dir, { codec: noVault }); await keys.initialize({ asAuthority: false })
    const stale = new FileKeyStore(dir, { codec: noVault }); keys.putSecret('winner', Buffer.from('yes'))
    expect(() => stale.putSecret('loser', Buffer.from('no'))).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(new FileKeyStore(dir, { codec: noVault }).getSecret('loser')).toBeUndefined()
    const linked = profile(); symlinkSync(join(dir, 'net'), join(linked, 'net'))
    expect(() => new FileKeyStore(linked, { codec: noVault })).toThrow(expect.objectContaining({ code: 'forbidden' }))
  })
})
