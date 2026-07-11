import { describe, expect, it } from 'vitest'
import { getDefaultSettings, AGENT_TYPES } from '../src/shared/settings'
import { buildOrchestratorSystemPrompt } from '../src/mms/orchestrator/systemPrompt'

describe('Mousse agent settings', () => {
  it('lists Mousse first and enabled by default', () => {
    expect(AGENT_TYPES[0]?.id).toBe('mousse')
    const settings = getDefaultSettings()
    expect(settings.agents.enabled.mousse).toBe(true)
    expect(settings.agents.headless.mousse).toBe(false)
  })

  it('mentions mousse as preferred spawn target in agent prompt', () => {
    const prompt = buildOrchestratorSystemPrompt({ mode: 'agent' })
    expect(prompt).toContain('"cliType": "mousse"')
    expect(prompt).toContain('preferred')
  })
})
