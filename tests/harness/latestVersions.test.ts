import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LATEST_RETRY_MS, LATEST_TTL_MS, LatestVersionCache, type LatestVersionSource } from '../../src/mms/harness/latest'
import { antigravityDriver } from '../../src/mms/harness/drivers/antigravity'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { acpDriver } from '../../src/mms/harness/drivers/acp'

const homes: string[] = []
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-latest-'))
  homes.push(dir)
  return dir
}

const claude: LatestVersionSource = { kind: 'npm', package: '@anthropic-ai/claude-code' }
const codex: LatestVersionSource = { kind: 'npm', package: '@openai/codex' }

function registry(versions: Record<string, unknown>) {
  const urls: string[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', '').replace(/\/latest$/, ''))
    if (!(name in versions)) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(versions[name]), { status: 200 })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls, calls: fetchImpl }
}

describe('latest published versions', () => {
  it('asks the registry once and answers from memory afterwards', async () => {
    const { fetchImpl, urls } = registry({ '@anthropic-ai/claude-code': { version: '2.2.0' } })
    const cache = new LatestVersionCache(home(), { fetchImpl })
    expect(cache.get(claude)).toBeUndefined()
    expect(await cache.refresh(claude)).toBe(true)
    expect(cache.get(claude)).toBe('2.2.0')
    expect(urls).toEqual(['https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest'])
    expect(await cache.refresh(claude)).toBe(false)
    expect(urls).toHaveLength(1)
  })

  it('looks a version up again only after 24 hours, and says whether it changed', async () => {
    let now = Date.parse('2026-10-26T00:00:00Z')
    const versions: Record<string, unknown> = { '@openai/codex': { version: '0.163.0' } }
    const { fetchImpl, calls } = registry(versions)
    const cache = new LatestVersionCache(home(), { fetchImpl, now: () => now })
    await cache.refresh(codex)
    now += LATEST_TTL_MS - 1
    expect(await cache.refresh(codex)).toBe(false)
    expect(calls).toHaveBeenCalledTimes(1)
    now += 1
    // Same version again: looked up, not a change.
    expect(await cache.refresh(codex)).toBe(false)
    expect(calls).toHaveBeenCalledTimes(2)
    versions['@openai/codex'] = { version: '0.164.0' }
    now += LATEST_TTL_MS
    expect(await cache.refresh(codex)).toBe(true)
    expect(cache.get(codex)).toBe('0.164.0')
  })

  it('treats a check dated in the future as expired', async () => {
    const dir = home()
    mkdirSync(join(dir, 'harness'))
    const now = Date.parse('2026-10-26T00:00:00Z')
    writeFileSync(join(dir, 'harness', 'latest-versions.json'), JSON.stringify({
      version: 1,
      entries: { '@openai/codex': { version: '0.150.0', checkedAt: new Date(now + 3 * LATEST_TTL_MS).toISOString() } }
    }))
    const { fetchImpl, calls } = registry({ '@openai/codex': { version: '0.163.0' } })
    const cache = new LatestVersionCache(dir, { fetchImpl, now: () => now })
    expect(cache.get(codex)).toBe('0.150.0')
    expect(await cache.refresh(codex)).toBe(true)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(cache.get(codex)).toBe('0.163.0')
  })

  it('keeps the last good version when a lookup fails and waits before trying again', async () => {
    let now = Date.parse('2026-10-26T00:00:00Z')
    let fail = false
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error('offline')
      return new Response(JSON.stringify({ version: '2.2.0' }), { status: 200 })
    }) as unknown as typeof fetch
    const cache = new LatestVersionCache(home(), { fetchImpl, now: () => now })
    await cache.refresh(claude)
    fail = true
    now += LATEST_TTL_MS
    expect(await cache.refresh(claude)).toBe(false)
    expect(cache.get(claude)).toBe('2.2.0')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // No new request while the retry wait lasts.
    now += LATEST_RETRY_MS - 1
    await cache.refresh(claude)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    now += 1
    await cache.refresh(claude)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(cache.get(claude)).toBe('2.2.0')
  })

  it('ignores an HTTP error and a body without a version', async () => {
    const { fetchImpl } = registry({ '@anthropic-ai/claude-code': { version: 'latest' }, '@openai/codex': { name: 'codex' } })
    const cache = new LatestVersionCache(home(), { fetchImpl })
    expect(await cache.refresh(claude)).toBe(false)
    expect(await cache.refresh(codex)).toBe(false)
    expect(await cache.refresh({ kind: 'npm', package: 'missing' })).toBe(false)
    expect(cache.get(claude)).toBeUndefined()
    expect(cache.get(codex)).toBeUndefined()
  })

  it('runs one lookup per package at a time', async () => {
    let release: (() => void) | undefined
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => (release = () => resolve(new Response(JSON.stringify({ version: '2.2.0' }), { status: 200 }))))
    ) as unknown as typeof fetch
    const cache = new LatestVersionCache(home(), { fetchImpl })
    const first = cache.refresh(claude)
    const second = cache.refresh(claude)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    release?.()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('answers a pinned version without ever fetching', async () => {
    const { fetchImpl, calls } = registry({})
    const cache = new LatestVersionCache(home(), { fetchImpl })
    const pinned: LatestVersionSource = { kind: 'pinned', version: '1.2.3' }
    expect(cache.get(pinned)).toBe('1.2.3')
    expect(await cache.refresh(pinned)).toBe(false)
    expect(cache.get(undefined)).toBeUndefined()
    expect(await cache.refresh(undefined)).toBe(false)
    expect(calls).not.toHaveBeenCalled()
  })

  it('survives a restart through its file, and a damaged file reads as empty', async () => {
    const dir = home()
    const now = Date.parse('2026-10-26T00:00:00Z')
    const { fetchImpl, calls } = registry({ '@anthropic-ai/claude-code': { version: '2.2.0' } })
    await new LatestVersionCache(dir, { fetchImpl, now: () => now }).refresh(claude)
    const stored = JSON.parse(readFileSync(join(dir, 'harness', 'latest-versions.json'), 'utf8'))
    expect(stored).toEqual({ version: 1, entries: { '@anthropic-ai/claude-code': { version: '2.2.0', checkedAt: new Date(now).toISOString() } } })

    const reopened = new LatestVersionCache(dir, { fetchImpl, now: () => now + 1_000 })
    expect(reopened.get(claude)).toBe('2.2.0')
    expect(await reopened.refresh(claude)).toBe(false)
    expect(calls).toHaveBeenCalledTimes(1)

    writeFileSync(join(dir, 'harness', 'latest-versions.json'), '{ not json')
    const damaged = new LatestVersionCache(dir, { fetchImpl })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(damaged.get(claude)).toBeUndefined()
    writeFileSync(join(dir, 'harness', 'latest-versions.json'), JSON.stringify({ version: 1, entries: { '@openai/codex': { version: 7 }, '@anthropic-ai/claude-code': { version: '2.3.0', checkedAt: 'x' } } }))
    expect(new LatestVersionCache(dir, { fetchImpl }).get(codex)).toBeUndefined()
    expect(new LatestVersionCache(dir, { fetchImpl }).get(claude)).toBe('2.3.0')
  })

  it('creates its folder on first write', async () => {
    const dir = join(home(), 'fresh')
    mkdirSync(dir)
    const { fetchImpl } = registry({ '@openai/codex': { version: '0.163.0' } })
    await new LatestVersionCache(dir, { fetchImpl }).refresh(codex)
    expect(JSON.parse(readFileSync(join(dir, 'harness', 'latest-versions.json'), 'utf8')).entries['@openai/codex'].version).toBe('0.163.0')
  })
})

describe('which drivers have a version source', () => {
  it('Claude Code and Codex use npm, Antigravity its pinned release, ACP none', () => {
    expect(claudeCodeDriver().latestVersion).toEqual(claude)
    expect(codexDriver({ builtIn: () => ({}) as never }).latestVersion).toEqual(codex)
    expect(antigravityDriver({ builtIn: () => ({}) as never }).latestVersion).toMatchObject({ kind: 'pinned' })
    expect(acpDriver().latestVersion).toBeUndefined()
  })
})
