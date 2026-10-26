/**
 * A managed Grok (agent CLIs plan §5): xAI's platform package from the npm registry, checked
 * against its published sha512, unpacked without npm, its compressed binary expanded, and every
 * file of the frozen set present. A mismatch or a missing file fails the install.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentInstalls } from '../../src/mms/harness/agents/install'
import { DIST_DIR } from '../../src/mms/harness/agents/receipt'
import { grokPackageSpec } from '../../src/mms/harness/drivers/grok'
import type { InstanceEnv } from '../../src/mms/harness/env'
import { tarGzOf, type ArchiveEntry } from './archiveFixtures'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const REGISTRY = 'https://npm.test/'
const SPEC = grokPackageSpec('1.0.70', 'linux', 'x64')
const PROGRAM = '#!/bin/sh\necho grok 1.0.70\n'

function setup(entries: ArchiveEntry[], options: { integrity?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-grok-install-'))
  dirs.push(home)
  const tarball = tarGzOf(entries)
  const sha512 = createHash('sha512').update(tarball).digest('base64')
  const requests: string[] = []
  const fetchFile = (async (url: string) => {
    requests.push(url)
    if (url === `${REGISTRY}@xai-official%2fgrok-linux-x64/1.0.70`)
      return Response.json({ name: SPEC.name, version: '1.0.70', dist: { integrity: options.integrity ?? `sha512-${sha512}`, tarball: `${REGISTRY}@xai-official/grok-linux-x64/-/grok-linux-x64-1.0.70.tgz` } })
    if (url === `${REGISTRY}@xai-official/grok-linux-x64/-/grok-linux-x64-1.0.70.tgz`) return new Response(tarball, { headers: { 'content-length': String(tarball.length) } })
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
  const installs = new AgentInstalls({
    installationHome: home,
    profileId: 'p1',
    registry: { agent: async () => undefined, cached: () => [] },
    platformKeys: ['linux-x86_64'],
    fetch: fetchFile,
    npmRegistry: REGISTRY
  })
  const env: InstanceEnv = { instanceId: 'grok:work', driver: 'grok', configRevision: 0, homeId: 'private:grok:work', env: { ...process.env }, searchPath: [] }
  const install = () => installs.installPackageBinary({ instanceId: 'grok:work', spec: SPEC, env, label: 'Grok', onProgress: () => {} })
  return { installs, install, requests }
}

const PACKAGE: ArchiveEntry[] = [
  { name: 'package/package.json', data: '{"name":"@xai-official/grok-linux-x64","version":"1.0.70"}' },
  { name: 'package/bin/grok.br', data: brotliCompressSync(Buffer.from(PROGRAM)) },
  { name: 'package/README.md', data: 'Grok' }
]

describe('a managed Grok', () => {
  it('installs the package checked against the npm sha512, with its binary expanded and recorded', async () => {
    const { install, installs } = setup(PACKAGE)
    const installed = await install()
    expect(installed.receipt).toMatchObject({
      agentId: 'xai-grok',
      version: '1.0.70',
      platform: 'linux-x86_64',
      artifactUrl: '@xai-official/grok-linux-x64@1.0.70',
      expected: { algorithm: 'sha512' },
      checksum: 'registry',
      launch: { cmd: 'bin/grok', args: [], env: {} }
    })
    expect(Object.keys(installed.receipt.files).sort()).toEqual(['README.md', 'bin/grok', 'package.json'])
    expect(readFileSync(join(installed.root, DIST_DIR, 'bin', 'grok'), 'utf8')).toBe(PROGRAM)
    expect(installs.installed(installs.packageSource(SPEC))?.hash).toBe(installed.hash)
    expect(await installs.changed(installed, undefined)).toBeUndefined()
  })

  it('refuses a download that does not match the npm registry checksum', async () => {
    const { install, installs } = setup(PACKAGE, { integrity: `sha512-${createHash('sha512').update('other').digest('base64')}` })
    await expect(install()).rejects.toThrow(/does not match the npm registry checksum/)
    expect(installs.installed(installs.packageSource(SPEC))).toBeUndefined()
  })

  it('fails when the package lacks a file of the frozen set', async () => {
    const { install, installs } = setup(PACKAGE.filter((entry) => entry.name !== 'package/bin/grok.br'))
    await expect(install()).rejects.toThrow(/bin\/grok/)
    expect(installs.installed(installs.packageSource(SPEC))).toBeUndefined()
  })
})
