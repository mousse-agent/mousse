import { describe, expect, it } from 'vitest'
import {
  NativeBotRuntime,
  effectiveBotPolicyDigest,
  type NativeBotDefinition,
  type NativeBotRuntimeOptions
} from '../../../../src/mms/bots/runtime'
import type { BotRunRequest } from '../../../../src/mms/net/contracts'
import type { BotProfile } from '../../../../src/shared/net'

const definition: NativeBotDefinition = {
  revision: 'v1',
  systemPrompt: 'Only compartment history. No local context.',
  billing: {
    provider: 'fixture',
    model: 'fixture',
    api: 'anthropic-messages',
    modelDigest: 'fixture-digest',
    sdkVersion: 'fixture',
    platform: process.platform,
    nodeVersion: process.versions.node,
    runtimeVersion: 'mousse-net-native-v1',
    maximumUnits: 60,
    maxOutputTokens: 50,
    maxRequestBytes: 65536,
    evidence: 'Local fixture only; no paid provider qualification'
  },
  readerTools: ['safe_read'],
  approval: 'never',
  maxModelCalls: 2,
  maxToolCalls: 4,
  maxElapsedMs: 10000
}

function options(next: Partial<NativeBotDefinition> = {}): NativeBotRuntimeOptions {
  return {
    profileId: 'profile-a',
    installationHome: '/unused',
    settings: {} as never,
    providerAuth: {} as never,
    sdkVersion: 'fixture',
    definition: { ...definition, ...next },
    compartments: {} as never,
    executionBinding: () => undefined,
    assertCurrent: () => {},
    qualification: { active: () => true, invalidate: () => {} }
  }
}

describe('native bot runtime without a model path', () => {
  it.each(['chat', 'reader', 'operator'] as const)(
    'reports %s as unsupported even when qualification says active',
    async (profile: BotProfile) => {
      const runtime = new NativeBotRuntime(options())
      expect(runtime.supports(profile)).toBe(false)
      await expect(
        runtime.run({ profile } as unknown as BotRunRequest, {} as never)
      ).rejects.toMatchObject({ code: 'profile_unsupported' })
    }
  )

  it('still refuses malformed definitions at construction', () => {
    expect(() => new NativeBotRuntime(options({ maxModelCalls: 0 }))).toThrow(
      expect.objectContaining({ code: 'profile_unsupported' })
    )
    expect(
      () => new NativeBotRuntime(options({ readerTools: ['safe_read', 'safe_read'] }))
    ).toThrow(expect.objectContaining({ code: 'profile_unsupported' }))
  })

  it('keeps the policy digest for the bot registry', () => {
    expect(effectiveBotPolicyDigest(definition, 'chat')).not.toBe(
      effectiveBotPolicyDigest(definition, 'reader')
    )
    expect(effectiveBotPolicyDigest(definition, 'reader')).toBe(
      effectiveBotPolicyDigest({ ...definition }, 'reader')
    )
  })
})
