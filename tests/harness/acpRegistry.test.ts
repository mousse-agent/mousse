/**
 * The ACP registry (agent CLIs plan §4): today's registry decodes with every entry it should, bad
 * ids, versions and command paths are dropped before they can become paths, registry variables
 * never set the launch path, loaders, homes or credentials, and agents with their own entry in
 * Mousse stay out of search.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AcpRegistry,
  agentView,
  cleanEnv,
  commandSegments,
  decodeAgent,
  decodeRegistry,
  pinnedPackage,
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
      binaryAgent({}, { cmd: './demo.exe:stream' }),
      binaryAgent({}, { cmd: './bin/NUL' }),
      binaryAgent({}, { archive: 'http://example.com/demo.tar.gz' }),
      binaryAgent({}, { archive: 'https://user:pass@example.com/demo.tar.gz' }),
      binaryAgent({}, { sha256: 'not-a-digest' }),
      { id: 'npm-agent', name: 'Npm', version: '1.0.0', distribution: { npx: { package: 'npm-agent@latest' } } },
      { id: 'npm-agent', name: 'Npm', version: '1.0.0', distribution: { npx: { package: 'npm-agent' } } }
    ]) expect(decodeAgent(bad), JSON.stringify(bad)).toBeUndefined()
    // One bad entry costs only itself.
    expect(decodeRegistry({ agents: [binaryAgent({ id: 'x/..' }), binaryAgent()] }).map((agent) => agent.id)).toEqual(['demo-agent'])
  })

  it('accepts runner packages pinned to one release only, scoped npm names included', () => {
    for (const spec of ['demo@1.2.3', '@scope/demo-acp@0.2.1', 'demo@v1.0.0-beta.1+7']) expect(pinnedPackage(spec, 'npx'), spec).toBe(true)
    for (const spec of ['demo', 'demo@latest', 'demo@^1.2.3', '@scope@1.0.0', '@scope/demo', 'demo@1.2', '../x@1.0.0']) expect(pinnedPackage(spec, 'npx'), spec).toBe(false)
    expect(pinnedPackage('fast-agent==0.3.1', 'uvx')).toBe(true)
    expect(pinnedPackage('fast-agent@0.3.1', 'uvx')).toBe(true)
    expect(pinnedPackage('@scope/x==1.0.0', 'uvx')).toBe(false)
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
    for (const covered of ['grok-build', 'cursor', 'antigravity-acp', 'claude-acp', 'codex-acp', 'opencode', 'opencode-v2']) expect(all).not.toContain(covered)
    expect(searchAgents(agents, 'opencode', platformKeys('linux', 'x64'))).toEqual([])
    expect(searchAgents(agents, 'gemini', platformKeys('linux', 'x64')).map((agent) => agent.id)[0]).toBe('gemini')
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

describe('ACP registry icons', () => {
  const icons = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'acp-registry-icons-2026-11-24.json'), 'utf8')) as { icons: Record<string, string> }
  const CDN = 'https://cdn.agentclientprotocol.com/registry/v1/latest'
  const npxAgent = (id: string, icon: unknown = `${CDN}/${id}.svg`, version = '1.0.0') => ({ id, name: id, version, icon, distribution: { npx: { package: `${id}@${version}` } } })
  const HOSTILE = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0h1"/></svg>'

  /**
   * A registry of `list.agents` and a CDN serving `served` icons; records every request with its
   * options. `clock.ms` is the registry's clock.
   */
  function setup(agents: unknown[], served: Record<string, () => Response | Promise<Response>>, dir = mkdtempSync(join(tmpdir(), 'mousse-registry-icons-'))) {
    dirs.push(dir)
    const list = { agents }
    const clock = { ms: Date.parse('2026-11-25T10:00:00Z') }
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, redirect: init?.redirect })
      if (url.endsWith('registry.json')) return new Response(JSON.stringify({ version: '1.0.0', agents: list.agents }))
      const answer = served[url]
      if (!answer) return new Response('missing', { status: 404 })
      return answer()
    }) as typeof fetch
    const registry = new AcpRegistry({ cachePath: join(dir, 'agents', 'registry.json'), fetch: fetchMock, now: () => clock.ms })
    const iconRequests = () => requests.filter((request) => request.url.endsWith('.svg')).map((request) => request.url.slice(CDN.length + 1))
    const listRequests = () => requests.filter((request) => request.url.endsWith('registry.json')).length
    return { dir, list, clock, registry, requests, iconRequests, listRequests }
  }

  /** Searches until no icon is still on its way, as the Add dialog does. */
  async function settledSearch(registry: AcpRegistry, query: string) {
    let found = await registry.search(query)
    for (let round = 0; round < 50 && found.some((agent) => agent.iconPending); round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      found = await registry.search(query)
    }
    return found
  }

  it('returns each agent with its cleaned icon as a data URL, fetched from the registry host without redirects', async () => {
    const { dir, registry, requests, iconRequests } = setup([npxAgent('goose'), npxAgent('kilo')], {
      [`${CDN}/goose.svg`]: () => new Response(icons.icons.goose),
      [`${CDN}/kilo.svg`]: () => new Response(icons.icons.kilo)
    })
    const found = await settledSearch(registry, '')
    expect(found.map((agent) => [agent.id, agent.iconMonochrome])).toEqual([['goose', true], ['kilo', true]])
    for (const agent of found) expect(agent.iconDataUrl, agent.id).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(Buffer.from(found[0]!.iconDataUrl!.split(',')[1]!, 'base64').toString('utf8')).toBe(icons.icons.goose!.trim())
    // Every icon request goes to the registry host and refuses redirects.
    const svgRequests = requests.filter((request) => request.url.endsWith('.svg'))
    expect(svgRequests.map((request) => new URL(request.url).host)).toEqual(['cdn.agentclientprotocol.com', 'cdn.agentclientprotocol.com'])
    expect(svgRequests.every((request) => request.redirect === 'error')).toBe(true)
    expect(readFileSync(join(dir, 'agents', 'icons', 'goose.svg'), 'utf8')).toBe(icons.icons.goose!.trim())
    // A later search uses the cache: no second icon request.
    await registry.search('goose')
    expect(iconRequests()).toHaveLength(2)
  })

  it('drops a hostile, oversized, failed or redirected icon without losing the agent or the other icons', async () => {
    const { registry, requests, iconRequests } = setup(
      [npxAgent('goose'), npxAgent('evil'), npxAgent('huge'), npxAgent('gone'), npxAgent('moved'), npxAgent('elsewhere', 'https://example.com/elsewhere.svg')],
      {
        [`${CDN}/goose.svg`]: () => new Response(icons.icons.goose),
        [`${CDN}/evil.svg`]: () => new Response(HOSTILE),
        [`${CDN}/huge.svg`]: () => new Response(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(40_000)}</svg>`),
        [`${CDN}/gone.svg`]: () => new Response('nope', { status: 500 }),
        // What fetch does with `redirect: 'error'` when the server redirects.
        [`${CDN}/moved.svg`]: () => Promise.reject(new TypeError('fetch failed: unexpected redirect'))
      }
    )
    const found = await settledSearch(registry, '')
    expect(found.map((agent) => agent.id).sort()).toEqual(['elsewhere', 'evil', 'gone', 'goose', 'huge', 'moved'])
    expect(found.filter((agent) => agent.iconDataUrl).map((agent) => agent.id)).toEqual(['goose'])
    // The icon off the registry host is never requested; each other icon once.
    expect(requests.some((request) => request.url.includes('example.com'))).toBe(false)
    expect(iconRequests().sort()).toEqual(['evil.svg', 'gone.svg', 'goose.svg', 'huge.svg', 'moved.svg'])
    // A failed icon is not asked for again on every keystroke.
    await settledSearch(registry, 'e')
    expect(iconRequests()).toHaveLength(5)
  })

  it('answers a search without waiting for any icon, marks the missing ones pending, and serves cached icons offline', async () => {
    let release: () => void = () => undefined
    const slow = new Promise<void>((resolve) => { release = resolve })
    const { dir, registry } = setup([npxAgent('goose'), npxAgent('kilo')], {
      [`${CDN}/goose.svg`]: async () => { await slow; return new Response(icons.icons.goose) },
      [`${CDN}/kilo.svg`]: async () => { await slow; return new Response(icons.icons.kilo) }
    })
    const first = await registry.search('')
    expect(first.map((agent) => [agent.id, Boolean(agent.iconDataUrl), agent.iconPending])).toEqual([['goose', false, true], ['kilo', false, true]])
    release()
    const later = await settledSearch(registry, '')
    expect(later.map((agent) => [agent.id, Boolean(agent.iconDataUrl), agent.iconPending])).toEqual([['goose', true, undefined], ['kilo', true, undefined]])
    // Offline, a new registry reads the list and both icons from disk.
    const offline = new AcpRegistry({ cachePath: join(dir, 'agents', 'registry.json'), fetch: (async () => { throw new Error('offline') }) as typeof fetch })
    expect((await offline.search('')).map((agent) => Boolean(agent.iconDataUrl))).toEqual([true, true])
    expect(offline.icon('goose')?.iconDataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  /**
   * Snapshots of added agents ask for a missing icon on every build, for as long as Mousse runs.
   * Each way an icon can be missing costs at most one request, and none of them the list.
   */
  it('never contacts the registry again from snapshots for a missing icon, however long Mousse runs', async () => {
    const offline = { on: false }
    const served = {
      [`${CDN}/evil.svg`]: () => new Response(HOSTILE),
      [`${CDN}/gone.svg`]: () => new Response('nope', { status: 404 }),
      [`${CDN}/away.svg`]: () => (offline.on ? Promise.reject(new TypeError('fetch failed')) : new Response(icons.icons.goose))
    }
    // `dropped` was added, then left the registry; `plain` lists no icon; `evil` is refused by
    // `sanitizeRegistrySvg`; `gone` answers 404; `away` is asked for while the computer is offline.
    const listed = [npxAgent('plain', null), npxAgent('evil'), npxAgent('gone'), npxAgent('away')]
    const ids = ['dropped', 'plain', 'evil', 'gone', 'away']
    const { dir, clock, registry, iconRequests, listRequests } = setup(listed, served)
    await registry.agents()
    offline.on = true
    const snapshotBuilds = async (target: AcpRegistry) => {
      for (const id of ids) expect(await target.cacheIcon(id), id).toBe(false)
    }
    await snapshotBuilds(registry)
    expect(iconRequests().sort()).toEqual(['away.svg', 'evil.svg', 'gone.svg'])
    // Three hours of snapshot builds, well past the old ten-minute retry and the list's age.
    for (let minute = 0; minute < 180; minute += 11) {
      clock.ms += 11 * 60_000
      await snapshotBuilds(registry)
    }
    expect(iconRequests()).toHaveLength(3)
    expect(listRequests()).toBe(1)
    // After a restart a day later, the outcomes are still known.
    const restarted = setup(listed, served, dir)
    restarted.clock.ms = clock.ms + 24 * 60 * 60_000
    await snapshotBuilds(restarted.registry)
    expect(restarted.requests).toEqual([])
  })

  it('tries a failed icon again once per new download of the list for a search, and a refused one only for a new version', async () => {
    const gone = { status: 404 }
    const { list, clock, registry, iconRequests, listRequests } = setup([npxAgent('gone'), npxAgent('evil')], {
      [`${CDN}/gone.svg`]: () => (gone.status === 200 ? new Response(icons.icons.goose) : new Response('nope', { status: gone.status })),
      [`${CDN}/evil.svg`]: () => new Response(HOSTILE)
    })
    await settledSearch(registry, '')
    await settledSearch(registry, '')
    expect(iconRequests().sort()).toEqual(['evil.svg', 'gone.svg'])
    // The list is downloaded again: the failed icon is tried once more, the refused one is not.
    clock.ms += 6 * 60_000
    await settledSearch(registry, '')
    await settledSearch(registry, '')
    expect(listRequests()).toBe(2)
    expect(iconRequests().sort()).toEqual(['evil.svg', 'gone.svg', 'gone.svg'])
    // A new version of the refused agent: its icon is fetched again; the failed one now arrives.
    list.agents = [npxAgent('gone'), npxAgent('evil', `${CDN}/evil.svg`, '2.0.0')]
    gone.status = 200
    clock.ms += 6 * 60_000
    const found = await settledSearch(registry, '')
    expect(iconRequests().sort()).toEqual(['evil.svg', 'evil.svg', 'gone.svg', 'gone.svg', 'gone.svg'])
    expect(found.find((agent) => agent.id === 'gone')?.iconDataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
  })
})
