import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyModelCatalogSignature } from '../src/mms/models/catalogSignature'
import { checkCatalogRevision } from '../scripts/check-model-catalog-revision.mjs'
import { generateCatalogKeyPair } from '../scripts/model-catalog-keygen.mjs'
import { signCatalogFile } from '../scripts/sign-model-catalog.mjs'

const root = join(__dirname, '..')
const catalog = (revision: number, name = 'Claude Test 1') =>
  `${JSON.stringify({ format: 1, revision, models: [{ id: 'claude-test-1', name, short: name.replace('Claude ', ''), maker: 'anthropic', released: '2026-01-01', routes: { claude: { id: 'claude-test-1' } } }] }, null, 2)}\n`

const runScript = (script: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })

const folders: string[] = []
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'model-catalog-publish-'))
  folders.push(path)
  return path
}
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('sign-model-catalog', () => {
  it('writes a raw 64-byte signature that verifies against the listed key', () => {
    const { privateKey, publicKey } = generateCatalogKeyPair()
    const file = join(folder(), 'models-1.json')
    writeFileSync(file, catalog(3))
    const sigPath = signCatalogFile(file, privateKey, [publicKey])
    expect(sigPath).toBe(`${file}.sig`)
    const signature = readFileSync(sigPath)
    expect(signature.length).toBe(64)
    expect(verifyModelCatalogSignature(readFileSync(file), signature, [publicKey])).toBe(true)
  })

  it('leaves no signature when the key is not one the code lists', () => {
    const { privateKey, publicKey } = generateCatalogKeyPair()
    const file = join(folder(), 'models-1.json')
    writeFileSync(file, catalog(3))
    expect(() => signCatalogFile(file, privateKey, [generateCatalogKeyPair().publicKey])).toThrow(publicKey)
    expect(existsSync(`${file}.sig`)).toBe(false)
  })

  it('refuses from the command line while the code lists no key', () => {
    const file = join(folder(), 'models-1.json')
    writeFileSync(file, catalog(3))
    const result = runScript('sign-model-catalog.mjs', [file], { MODEL_CATALOG_SIGNING_KEY: generateCatalogKeyPair().privateKey })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MODEL_CATALOG_PUBLIC_KEYS')
    expect(existsSync(`${file}.sig`)).toBe(false)
  })
})

describe('check-model-catalog-revision', () => {
  it('passes a higher revision, identical bytes, or no earlier copy', () => {
    expect(checkCatalogRevision(catalog(1), catalog(2, 'Claude Test 2')).ok).toBe(true)
    expect(checkCatalogRevision(catalog(5), catalog(5)).ok).toBe(true)
    expect(checkCatalogRevision(null, catalog(1)).ok).toBe(true)
  })

  it('fails a change whose revision stayed or fell', () => {
    const same = checkCatalogRevision(catalog(4), catalog(4, 'Claude Test 2'))
    expect(same.ok).toBe(false)
    expect(same.message).toContain('Set "revision" to 5')
    expect(checkCatalogRevision(catalog(4), catalog(3, 'Claude Test 2')).ok).toBe(false)
    // Any byte counts as a change, even one JSON readers would not notice.
    expect(checkCatalogRevision(catalog(4), catalog(4).replace('\n}', '}')).ok).toBe(false)
  })

  it('fails when either side has no whole-number revision', () => {
    expect(checkCatalogRevision(catalog(1), '{"format":1}').ok).toBe(false)
    expect(checkCatalogRevision(catalog(1), 'not json').ok).toBe(false)
    expect(checkCatalogRevision('{"revision":"1"}', catalog(2)).ok).toBe(false)
  })

  it('compares the checkout with a git revision', () => {
    const result = runScript('check-model-catalog-revision.mjs', ['--base', 'HEAD'])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})

describe('model-catalog-keygen --dry-run', () => {
  it('prints only the public key line, and no private key material', () => {
    const result = runScript('model-catalog-keygen.mjs', ['--dry-run'])
    expect(result.status).toBe(0)
    const lines = result.stdout.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const match = /^'([A-Za-z0-9+/]{43}=)',$/.exec(lines[0])
    expect(match).not.toBeNull()
    expect(Buffer.from(match![1], 'base64').length).toBe(32)
    // Every Ed25519 PKCS#8 key starts with the same bytes; none of its text appears anywhere.
    const privatePrefix = generateCatalogKeyPair().privateKey.slice(0, 20)
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain(privatePrefix)
      expect(output).not.toMatch(/PRIVATE KEY/)
    }
  })
})
