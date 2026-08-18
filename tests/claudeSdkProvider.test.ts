import { describe, expect, it } from 'vitest'
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

  it('builds an SDK client with authToken for Claude OAuth secrets', () => {
    const client = createClaudeSdkClient({ authToken: 'sk-ant-oat-test' })
    expect(client.authToken).toBe('sk-ant-oat-test')
  })
})
