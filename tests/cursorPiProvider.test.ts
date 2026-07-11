import { describe, expect, it } from 'vitest'
import { CURSOR_PROVIDER_ID, toCursorPiModels } from '../src/mms/providers/cursorPiProvider'

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
})
