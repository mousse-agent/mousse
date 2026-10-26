/**
 * The ACP registry (agent CLIs plan §4): today's registry decodes with every entry it should, bad
 * ids, versions and command paths are dropped before they can become paths, registry variables
 * never set the launch path, loaders, homes or credentials, and agents with their own entry in
 * Mousse stay out of search.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AcpRegistry,
  agentView,
  cleanEnv,
  commandSegments,
  decodeAgent,
  decodeRegistry,
  platformKeys,
  REGISTRY_MAX_BYTES,
  resolveDistribution,
  searchAgents
} from '../../src/mms/harness/agents/registry'

const frozen = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'acp-registry-2026-10-26.json'), 'utf8')) as { agents: Array<Record<string, unknown>> }

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const binaryAgent = (patch: Record<string, unknown> = {}, target: Record<string, unknown> = {}) => ({
  id: 'demo-agent',
  name: 'Demo',
  version: '1.2.3',
  description: 'A demo agent',
  distribution: {
    binary: { 'linux-x86_64': { archive: 'https://github.com/demo/demo/releases/download/v1.2.3/demo.tar.gz', cmd: './demo', sha256: 'a'.repeat(64), ...target } }
  },
  ...patch
})

describe('the ACP registry', () => {
  it('decodes the frozen registry of 2026-10-26 entry by entry', () => {
    const agents = decodeRegistry(frozen)
    expect(agents).toHaveLength(43)
    const amp = agents.find((agent) => agent.id === 'amp-acp')!
    expect(amp.distribution.binary?.['windows-x86_64']).toMatchObject({ cmd: 'amp-acp.exe', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(agents.find((agent) => agent.id === 'agoragentic-acp')?.distribution.npx).toEqual({ package: 'agoragentic-mcp@1.3.0', args: ['--acp'], env: {} })
    // Backslash command paths (`./bin\devin.exe`) read as `/`-separated.
    expect(commandSegments('./bin\\devin.exe')).toEqual(['bin', 'devin.exe'])
  })

  it('drops entries whose id, version or command could leave their folder, and non-HTTPS downloads', () => {
    for (const bad of [
      binaryAgent({ id: 'Bad/../x' }),
      binaryAgent({ id: '.hidden' }),
      binaryAgent({ version: '../1.0.0' }),
      binaryAgent({ version: '1.0.0/..' }),
      binaryAgent({}, { cmd: '../escape' }),
      binaryAgent({}, { cmd: '/usr/bin/demo' }),
      binaryAgent({}, { cmd: 'C:\\demo.exe' }),
      binaryAgent({}, { cmd: '\\\\server\\share\\demo.exe' }),
      binaryAgent({}, { cmd: './bin/../../demo' }),
      binaryAgent({}, { archive: 'http://example.com/demo.tar.gz' }),
      binaryAgent({}, { archive: 'https://user:pass@example.com/demo.tar.gz' }),
      binaryAgent({}, { sha256: 'not-a-digest' }),
      { id: 'npm-agent', name: 'Npm', version: '1.0.0', distribution: { npx: { package: 'npm-agent@latest' } } },
      { id: 'npm-agent', name: 'Npm', version: '1.0.0', distribution: { npx: { package: 'npm-agent' } } }
    ]) expect(decodeAgent(bad), JSON.stringify(bad)).toBeUndefined()
    // One bad entry costs only itself.
    expect(decodeRegistry({ agents: [binaryAgent({ id: 'x/..' }), binaryAgent()] }).map((agent) => agent.id)).toEqual(['demo-agent'])
  })

  it('never lets registry variables set the launch path, loaders, homes or credentials', () => {
    expect(cleanEnv({
      PATH: '/evil', Path: 'C:\\evil', NODE_OPTIONS: '--require x', LD_PRELOAD: 'x.so', DYLD_INSERT_LIBRARIES: 'x', ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_CONFIG_DIR: '/tmp', CODEX_HOME: '/tmp', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', HOME: '/tmp',
      'BAD NAME': 'x', AGENT_DISABLE_AUTO_UPDATE: '1'
    })).toEqual({ AGENT_DISABLE_AUTO_UPDATE: '1' })
    const agent = decodeAgent(binaryAgent({}, { env: { PATH: '/evil', DEMO_MODE: 'acp' }, args: ['--acp'] }))!
    expect(agentView(agent, ['linux-x86_64'])).toMatchObject({ env: { DEMO_MODE: 'acp' }, args: ['--acp'], checksum: 'registry', distribution: 'binary' })
  })

  it('picks the platform build, with Windows on Arm falling back to x64', () => {
    expect(platformKeys('win32', 'arm64')).toEqual(['windows-aarch64', 'windows-x86_64'])
    expect(platformKeys('darwin', 'arm64')).toEqual(['darwin-aarch64'])
    expect(platformKeys('linux', 'ia32')).toEqual([])
    const agents = decodeRegistry(frozen)
    const opencode = agents.find((agent) => agent.id === 'opencode')!
    expect(resolveDistribution(opencode, ['windows-aarch64', 'windows-x86_64'])).toMatchObject({ kind: 'binary' })
  })

  it('labels downloads by checksum and lists what Mousse cannot install yet', () => {
    const agents = decodeRegistry(frozen)
    const view = (id: string, keys = platformKeys('linux', 'x64')) => agentView(agents.find((agent) => agent.id === id)!, keys)!
    expect(view('amp-acp')).toMatchObject({ checksum: 'registry', distribution: 'binary' })
    expect(view('crow-cli')).toMatchObject({ checksum: 'none', distribution: 'binary' })
    expect(view('crow-cli').unsupported).toBeUndefined()
    // tar.bz2 and raw executables are refused with a reason.
    expect(view('goose').unsupported).toMatch(/zip and tar\.gz/)
    expect(view('sigit').unsupported).toMatch(/zip and tar\.gz/)
    const uvx = agents.find((agent) => agent.distribution.uvx && !agent.distribution.binary && !agent.distribution.npx)
    if (uvx) expect(agentView(uvx)).toMatchObject({ distribution: 'uvx', unsupported: expect.stringMatching(/Custom command/) })
  })

  it('leaves agents with their own Mousse entry out of search, best match first', () => {
    const agents = decodeRegistry(frozen)
    const all = searchAgents(agents, '', platformKeys('linux', 'x64')).map((agent) => agent.id)
    for (const covered of ['grok-build', 'cursor', 'antigravity-acp', 'claude-acp', 'codex-acp']) expect(all).not.toContain(covered)
    expect(searchAgents(agents, 'open', platformKeys('linux', 'x64')).map((agent) => agent.id).slice(0, 2)).toEqual(expect.arrayContaining(['opencode']))
    expect(searchAgents(agents, 'zzzz-nothing')).toEqual([])
  })

  it('fetches network first, falls back to the cached copy, and refuses an oversized registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-registry-'))
    dirs.push(dir)
    const cachePath = join(dir, 'agents', 'registry.json')
    let clock = 0
    let answer: () => Response = () => new Response(JSON.stringify({ version: '1.0.0', agents: [binaryAgent()] }))
    const registry = new AcpRegistry({ cachePath, fetch: (async () => answer()) as typeof fetch, now: () => clock })
    expect((await registry.agents()).map((agent) => agent.id)).toEqual(['demo-agent'])
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).agents).toHaveLength(1)
    // Offline: the cached copy serves.
    clock += 10 * 60_000
    answer = () => { throw new Error('offline') }
    const offline = new AcpRegistry({ cachePath, fetch: (async () => answer()) as typeof fetch, now: () => clock })
    expect((await offline.agents()).map((agent) => agent.id)).toEqual(['demo-agent'])
    // Too large: the network answer is refused, the cache serves.
    answer = () => new Response('x'.repeat(REGISTRY_MAX_BYTES + 1))
    const large = new AcpRegistry({ cachePath, fetch: (async () => answer()) as typeof fetch, now: () => clock })
    expect((await large.agents()).map((agent) => agent.id)).toEqual(['demo-agent'])
    // No cache and no network: a clear error.
    writeFileSync(cachePath, 'not json')
    const broken = new AcpRegistry({ cachePath, fetch: (async () => answer()) as typeof fetch, now: () => clock })
    await expect(broken.agents()).rejects.toThrow(/could not load the ACP registry/)
  })
})
