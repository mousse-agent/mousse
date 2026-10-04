import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { Cursor, type ModelListItem } from '@cursor/sdk'
import { buildCursorModelSelection, getCursorModelMetadata } from 'pi-cursor-sdk/src/model-discovery'
import { fingerprintApiKey, saveModelListCache } from 'pi-cursor-sdk/src/model-list-cache'
import { createCursorPiProvider, CURSOR_PROVIDER_ID, registerCursorPiProvider, toCursorPiModels } from '../src/mms/providers/cursorPiProvider'

describe('cursorPiProvider', () => {
  it('maps discovered cursor models into pi-ai models', () => {
    const [model] = toCursorPiModels([
      {
        id: 'composer-2-5',
        name: 'Composer 2.5',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxTokens: 16_384
      }
    ])

    expect(model.provider).toBe(CURSOR_PROVIDER_ID)
    expect(model.api).toBe('cursor-sdk')
    expect(model.id).toBe('composer-2-5')
    expect(model.baseUrl).toBe('https://cursor.com')
  })

  it('passes the stored API key directly without changing the process environment', async (context) => {
    const credentials = new InMemoryCredentialStore()
    await credentials.modify(CURSOR_PROVIDER_ID, async () => ({ type: 'api_key', key: 'stored-cursor-key' }))
    const before = process.env.CURSOR_API_KEY
    const list = vi.spyOn(Cursor.models, 'list').mockImplementation(async (options) => {
      expect(options).toEqual({ apiKey: 'stored-cursor-key' })
      expect(process.env.CURSOR_API_KEY).toBe(before)
      return []
    })
    context.onTestFinished(() => list.mockRestore())
    const models = createModels({ credentials })
    models.setProvider(createCursorPiProvider(credentials))
    await models.refresh({ allowNetwork: false })
    expect(list).not.toHaveBeenCalled()
    const result = await models.refresh({ allowNetwork: true })
    expect(result.errors.size).toBe(0)
    expect(list).toHaveBeenCalledTimes(1)
    expect(process.env.CURSOR_API_KEY).toBe(before)
  })

  it('restores key-matched cached variant metadata without discovery', async (context) => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-cursor-cache-'))
    context.onTestFinished(() => {
      vi.unstubAllEnvs()
      if (!dir.startsWith(join(tmpdir(), 'mousse-cursor-cache-'))) throw new Error('Unsafe fixture cleanup')
      rmSync(dir, { recursive: true, force: true })
    })
    vi.stubEnv('PI_CODING_AGENT_DIR', dir)
    vi.stubEnv('PI_CURSOR_SDK_DISABLE_MODEL_CACHE', 'false')
    const apiKey = 'cached-variant-key'
    expect(saveModelListCache(fingerprintApiKey(apiKey), [{
      id: 'cached-new-model', displayName: 'Cached New Model', aliases: ['cached-alias'],
      parameters: [
        { id: 'context', values: [{ value: '128k' }, { value: '1m' }] },
        { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
        { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] }
      ],
      variants: [{ displayName: 'Default', isDefault: true, params: [
        { id: 'context', value: '128k' }, { id: 'fast', value: 'false' }, { id: 'effort', value: 'low' }
      ] }]
    }])).toBe(true)
    const credentials = new InMemoryCredentialStore()
    await credentials.modify(CURSOR_PROVIDER_ID, async () => ({ type: 'api_key', key: apiKey }))
    const models = createModels({ credentials })
    const list = vi.spyOn(Cursor.models, 'list')
    context.onTestFinished(() => list.mockRestore())
    await registerCursorPiProvider(models, credentials, { allowNetwork: false })
    const selected = 'cached-alias@1m:fast'
    expect(models.getModel(CURSOR_PROVIDER_ID, selected)).toBeDefined()
    expect(buildCursorModelSelection(selected, 'high')).toEqual({
      id: 'cached-alias', params: [
        { id: 'context', value: '1m' }, { id: 'fast', value: 'true' }, { id: 'effort', value: 'high' }
      ]
    })
    expect(list).not.toHaveBeenCalled()

    await credentials.modify(CURSOR_PROVIDER_ID, async () => ({ type: 'api_key', key: 'different-key' }))
    await registerCursorPiProvider(models, credentials, { allowNetwork: false })
    expect(models.getModel(CURSOR_PROVIDER_ID, selected)).toBeUndefined()
    expect(models.getModels(CURSOR_PROVIDER_ID).length).toBeGreaterThan(0)
    expect(list).not.toHaveBeenCalled()
  })

  it('discards late Cursor responses without changing selection metadata or the raw cache', async (context) => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-cursor-cache-'))
    context.onTestFinished(() => {
      vi.unstubAllEnvs()
      if (!dir.startsWith(join(tmpdir(), 'mousse-cursor-cache-'))) throw new Error('Unsafe fixture cleanup')
      rmSync(dir, { recursive: true, force: true })
    })
    vi.stubEnv('PI_CODING_AGENT_DIR', dir)
    vi.stubEnv('PI_CURSOR_SDK_DISABLE_MODEL_CACHE', 'false')
    const apiKey = 'late-response-key'
    expect(saveModelListCache(fingerprintApiKey(apiKey), [{ id: 'accepted-model', displayName: 'Accepted Model' }])).toBe(true)
    const rawBefore = readFileSync(join(dir, 'cursor-sdk-model-list.json'), 'utf8')
    const credentials = new InMemoryCredentialStore()
    await credentials.modify(CURSOR_PROVIDER_ID, async () => ({ type: 'api_key', key: apiKey }))
    const models = createModels({ credentials })
    await registerCursorPiProvider(models, credentials, { allowNetwork: false })
    let resolve!: (items: ModelListItem[]) => void
    const list = vi.spyOn(Cursor.models, 'list').mockImplementation(() => new Promise((done) => { resolve = done }))
    context.onTestFinished(() => list.mockRestore())
    const abort = new AbortController()
    const refresh = models.refresh({ allowNetwork: true, signal: abort.signal })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    abort.abort()
    await refresh
    resolve([{ id: 'discarded-model', displayName: 'Discarded Model' }])
    await new Promise((done) => setImmediate(done))
    expect(getCursorModelMetadata('accepted-model')).toBeDefined()
    expect(getCursorModelMetadata('discarded-model')).toBeUndefined()
    expect(models.getModel(CURSOR_PROVIDER_ID, 'discarded-model')).toBeUndefined()
    expect(readFileSync(join(dir, 'cursor-sdk-model-list.json'), 'utf8')).toBe(rawBefore)
  })
})
