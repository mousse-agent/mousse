import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import {
  PiCatalogOverlay,
  parseProviderCatalog,
  piCatalogDataUrl
} from '../src/mms/providers/piCatalogOverlay'

const SOL = {
  id: 'gpt-6-sol',
  name: 'GPT-6 Sol',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  contextWindow: 272000,
  maxTokens: 128000,
  thinkingLevelMap: { off: 'none', high: 'high', ultra: 'ultra' }
}

function fixtureDir(context: { onTestFinished: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-catalog-test-'))
  context.onTestFinished(() => {
    if (!dir.startsWith(join(tmpdir(), 'mousse-catalog-test-'))) throw new Error('Unsafe fixture cleanup')
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('parseProviderCatalog', () => {
  const apis = new Set(['openai-codex-responses'])

  it('keeps valid models and drops unknown thinking levels', () => {
    const [model] = parseProviderCatalog('openai-codex', { 'openai-codex-responses': { [SOL.id]: SOL } }, apis)
    expect(model.id).toBe('gpt-6-sol')
    expect(model.thinkingLevelMap).toEqual({ off: 'none', high: 'high' })
  })

  it('rejects models the provider cannot stream or that fail validation', () => {
    const raw = {
      group: {
        otherApi: { ...SOL, id: 'a', api: 'openai-completions' },
        otherProvider: { ...SOL, id: 'b', provider: 'openai' },
        badCost: { ...SOL, id: 'c', cost: { input: 1 } },
        badInput: { ...SOL, id: 'd', input: ['audio'] },
        badHeaders: { ...SOL, id: 'e', headers: { 'X-Test': 1 } },
        valid: { ...SOL, id: 'f', headers: { 'X-Test': 'ok' } }
      }
    }
    expect(parseProviderCatalog('openai-codex', raw, apis).map((model) => model.id)).toEqual(['f'])
    expect(parseProviderCatalog('openai-codex', ['not', 'a', 'catalog'], apis)).toEqual([])
  })
})

describe('PiCatalogOverlay', () => {
  it('adds newly published models, keeps bundled definitions, and restores from cache', async (context) => {
    const dir = fixtureDir(context)
    const cachePath = join(dir, 'pi-catalog-cache.json')
    const models = builtinModels()
    const bundled = models.getModels('openai-codex')
    expect(bundled.some((model) => model.id === 'gpt-6-sol')).toBe(false)
    const existing = bundled[0]!

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/latest')) return jsonResponse({ version: '9.9.9' })
      if (url === piCatalogDataUrl('9.9.9', 'openai-codex')) {
        return jsonResponse({
          'openai-codex-responses': {
            [SOL.id]: SOL,
            [existing.id]: { ...existing, name: 'Renamed upstream' }
          }
        })
      }
      return jsonResponse({}, 404)
    })
    const overlay = new PiCatalogOverlay(cachePath, { fetchImpl: fetchImpl as typeof fetch })
    const provider = models.getProvider('openai-codex')!
    overlay.attach(provider)

    await expect(overlay.refresh()).resolves.toBe(true)
    const merged = models.getModels('openai-codex')
    expect(merged.find((model) => model.id === 'gpt-6-sol')?.name).toBe('GPT-6 Sol')
    expect(merged.find((model) => model.id === existing.id)?.name).toBe(existing.name)
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).piVersion).toBe('9.9.9')

    // Within the check interval nothing is fetched again.
    fetchImpl.mockClear()
    await expect(overlay.refresh()).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()

    // A fresh daemon restores the overlay from disk while offline.
    const restartedModels = builtinModels()
    const restarted = new PiCatalogOverlay(cachePath, {
      fetchImpl: (async () => { throw new Error('offline') }) as typeof fetch
    })
    restarted.attach(restartedModels.getProvider('openai-codex')!)
    expect(restartedModels.getModels('openai-codex').some((model) => model.id === 'gpt-6-sol')).toBe(true)
  })

  it('keeps the bundled catalog when the cache is corrupt and the network fails', async (context) => {
    const dir = fixtureDir(context)
    const cachePath = join(dir, 'pi-catalog-cache.json')
    writeFileSync(cachePath, '{not json')
    const models = builtinModels()
    const before = models.getModels('openai-codex').map((model) => model.id)
    const overlay = new PiCatalogOverlay(cachePath, {
      fetchImpl: (async () => { throw new Error('offline') }) as typeof fetch
    })
    overlay.attach(models.getProvider('openai-codex')!)
    await expect(overlay.refresh()).rejects.toThrow('offline')
    expect(models.getModels('openai-codex').map((model) => model.id)).toEqual(before)
  })

  it('does not update the cache after cancellation while checking the same package version', async (context) => {
    const dir = fixtureDir(context)
    const path = join(dir, 'pi-catalog-cache.json')
    const cached = { version: 1, piVersion: '9.9.9', checkedAt: 1, providers: {} }
    writeFileSync(path, JSON.stringify(cached))
    const abort = new AbortController()
    const overlay = new PiCatalogOverlay(path, {
      fetchImpl: (async () => {
        abort.abort()
        return jsonResponse({ version: '9.9.9' })
      }) as typeof fetch
    })
    await expect(overlay.refresh({ signal: abort.signal })).rejects.toThrow()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(cached)
  })
})
