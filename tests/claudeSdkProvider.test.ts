import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import {
  CLAUDE_PROVIDER_ID,
  createClaudeSdkClient,
  toClaudePiModels
} from '../src/mms/providers/claudeSdkProvider'

describe('claudeSdkProvider', () => {
  it('maps Claude SDK model infos onto anthropic-messages models', () => {
    const [model] = toClaudePiModels([
      { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' }
    ])
    expect(model.provider).toBe(CLAUDE_PROVIDER_ID)
    expect(model.api).toBe('anthropic-messages')
    expect(model.id).toBe('claude-opus-4-7')
    expect(model.name).toBe('Claude Opus 4.7')
    expect(model.baseUrl).toBe('https://api.anthropic.com')
  })

  it('rejects Claude subscription tokens for the Messages SDK', () => {
    expect(() => createClaudeSdkClient({ apiKey: 'sk-ant-oat-test' })).toThrow(/subscription credentials/)
    expect(() => createClaudeSdkClient({ apiKey: 'sk-ant-ort-test' })).toThrow(/subscription credentials/)
  })

  it('does not offer Claude subscription login through Anthropic Messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-claude-auth-'))
    const auth = new ProviderAuthService(join(dir, 'auth.json'))
    try {
      await expect(auth.setApiKey('anthropic', 'sk-ant-oat-secret')).rejects.toThrow(/subscription credentials/)
      expect(auth.has('anthropic')).toBe(false)
      expect(auth.getLoginOptions('oauth').some((option) => option.id === 'anthropic')).toBe(false)
    } finally {
      auth.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
