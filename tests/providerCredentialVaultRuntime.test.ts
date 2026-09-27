import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(rel) || !rel.startsWith('mousse-vault-runtime-') || rel.includes('..')) throw new Error('Unsafe vault fixture cleanup')
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

async function run(command: string, entry: string, phase: string, root: string): Promise<void> {
  const env = { ...process.env, MOUSSE_HOME: join(root, 'home'), MOUSSE_ELECTRON_USER_DATA: join(root, 'electron-user-data') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(command, [entry, phase, root], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((done, reject) => {
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Vault fixture ${phase} timed out`)) }, 20_000)
    child.stdout.on('data', (bytes: Buffer) => { output = (output + bytes.toString()).slice(-16_384) })
    child.stderr.on('data', (bytes: Buffer) => { output = (output + bytes.toString()).slice(-16_384) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || !output.includes(`VAULT_PROBE_OK:${phase}`)) reject(new Error(`Vault fixture ${phase} failed (${code}): ${output}`))
      else done()
    })
  })
}

// Windows exercises real DPAPI without depending on a CI desktop keyring. Linux
// basic_text is not equivalent evidence; codec failure cases have unit coverage.
describe.skipIf(process.platform !== 'win32')('provider credentials across real runtimes', () => {
  it.each(['cjs', 'esm'] as const)('preserves %s Electron-encrypted providers after a plain Node open attempt and Electron restart', async (format) => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-vault-runtime-'))
    roots.push(root)
    const entry = join(root, format === 'cjs' ? 'vault-probe.cjs' : 'vault-probe.mjs')
    await build({ entryPoints: [resolve('tests/fixtures/provider-credentials/vault-probe.ts')], outfile: entry,
      bundle: true, platform: 'node', format, target: 'node22', external: ['electron'] })
    const electron = createRequire(import.meta.url)('electron') as string
    await run(electron, entry, 'write', root)
    const auth = join(root, 'home', 'auth.json')
    const original = readFileSync(auth)
    expect(JSON.parse(original.toString()).__mousse_encrypted_v1).toEqual(expect.any(String))
    expect(original.toString()).not.toContain('synthetic-')
    await run(process.execPath, entry, 'node-reject', root)
    expect(readFileSync(auth)).toEqual(original)
    expect(readdirSync(join(root, 'home'))).toEqual(['auth.json'])
    await run(electron, entry, 'read', root)
    expect(readFileSync(auth)).toEqual(original)
    expect(readdirSync(join(root, 'home'))).toEqual(['auth.json'])
  }, 65_000)
})
