import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function service(): ProviderAuthService {
  const home = mkdtempSync(join(tmpdir(), 'mousse-uncached-price-'))
  homes.push(home)
  return new ProviderAuthService(join(home, 'auth.json'))
}

describe('the price of re-reading a cold cache', () => {
  it('is the cache write price of a priced model, only for a provider paid by API key', async () => {
    const auth = service()
    const model = auth.models.getModels('anthropic').find((entry) => entry.cost.cacheWrite > 0 && entry.cost.input > 0)!
    expect(model).toBeDefined()
    // Not signed in: nothing is billed here.
    expect(auth.uncachedInputPrice('anthropic', model.id)).toBeUndefined()
    await auth.setApiKey('anthropic', 'sk-ant-api03-test-key')
    expect(auth.uncachedInputPrice('anthropic', model.id)).toBe(model.cost.cacheWrite)
    // A model the catalogue does not know has no price.
    expect(auth.uncachedInputPrice('anthropic', 'no-such-model')).toBeUndefined()
  })

  it('falls back to the input price where the catalogue has no cache write price', async () => {
    const auth = service()
    const model = auth.models.getModels('openai').find((entry) => entry.cost.cacheWrite === 0 && entry.cost.input > 0)
    if (!model) return
    await auth.setApiKey('openai', 'sk-test-key')
    expect(auth.uncachedInputPrice('openai', model.id)).toBe(model.cost.input)
  })
})
