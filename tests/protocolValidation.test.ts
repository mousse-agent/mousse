/**
 * Adversarial validation of protocol nested payloads.
 */

import { describe, expect, it } from 'vitest'
import {
  asChannelConfigPatch,
  asChannelPlatform,
  asCreateScheduledJobInput,
  asCursorMcpConfigPatch,
  asPlainObject,
  asProviderLoginResponse,
  asScheduledJobPatch,
  asSettingsPartial,
  asStringEnvMap,
  asTaskStatus
} from '../src/mms/protocol/validators'

describe('protocol nested validators', () => {
  it('rejects prototype pollution keys', () => {
    const polluted = JSON.parse('{"constructor":{"prototype":{"x":1}}}')
    expect(() => asPlainObject(polluted, 'o')).toThrow(/forbidden/)
    const settingsPolluted = JSON.parse(
      '{"profile":{"username":"a"},"constructor":{"evil":true}}'
    )
    expect(() => asSettingsPartial(settingsPolluted)).toThrow()
  })

  it('validates schedule discriminants and ranges', () => {
    expect(
      asCreateScheduledJobInput({
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'interval', minutes: 30 }
      }).schedule.minutes
    ).toBe(30)
    expect(() =>
      asCreateScheduledJobInput({
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'interval', minutes: 0 }
      })
    ).toThrow(/minutes/)
    expect(() =>
      asCreateScheduledJobInput({
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'once' }
      })
    ).toThrow(/runAt/)
    expect(() =>
      asCreateScheduledJobInput({
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'cron', expr: 'bad' }
      })
    ).toThrow(/cron/)
    expect(() =>
      asCreateScheduledJobInput({
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'interval', minutes: 5 },
        evil: true
      })
    ).toThrow(/not allowed/)
  })

  it('validates job patches', () => {
    expect(asScheduledJobPatch({ enabled: false }).enabled).toBe(false)
    expect(() => asScheduledJobPatch({ state: 'running' })).toThrow(/not allowed/)
  })

  it('validates channel platforms and config patches', () => {
    expect(asChannelPlatform('telegram')).toBe('telegram')
    expect(() => asChannelPlatform('irc')).toThrow()
    const patch = asChannelConfigPatch({
      platforms: { telegram: { enabled: true, token: 't' } },
      filterSilenceNarration: true
    })
    expect(patch.platforms?.telegram?.enabled).toBe(true)
    expect(() =>
      asChannelConfigPatch({ platforms: { telegram: { enabled: true, hack: 1 } } })
    ).toThrow(/not allowed/)
  })

  it('drops blank optional channel secrets instead of throwing', () => {
    const patch = asChannelConfigPatch({
      platforms: {
        webhook: { enabled: false, webhookSecret: '', webhookPort: 18789 },
        telegram: { enabled: false, token: '  ', homeChatId: '' }
      }
    })
    expect(patch.platforms?.webhook?.webhookSecret).toBeUndefined()
    expect(patch.platforms?.webhook?.webhookPort).toBe(18789)
    expect(patch.platforms?.telegram?.token).toBeUndefined()
    expect(patch.platforms?.telegram?.homeChatId).toBeUndefined()
  })

  it('bounds settings partials and env maps', () => {
    expect(asSettingsPartial({ profile: { username: 'u' } })).toEqual({
      profile: { username: 'u' }
    })
    expect(() => asSettingsPartial({ notASection: true })).toThrow(/not allowed/)
    expect(asStringEnvMap({ FOO: 'bar' }).FOO).toBe('bar')
    expect(() => asStringEnvMap({ 'bad-key': 'x' })).toThrow()
    expect(() => asStringEnvMap({ FOO: 'x'.repeat(5000) })).toThrow()
  })

  it('strictly validates provider login responses', () => {
    expect(
      asProviderLoginResponse({ sessionId: 's1', kind: 'prompt', value: 'secret' })
    ).toEqual({ sessionId: 's1', kind: 'prompt', value: 'secret' })
    expect(() => asProviderLoginResponse({ sessionId: 's1', kind: 'execute' })).toThrow(
      /response.kind/
    )
    expect(() =>
      asProviderLoginResponse({ sessionId: 's1', kind: 'cancel', extra: true })
    ).toThrow(/unknown field/)
  })

  it('validates task status and MCP patch size', () => {
    expect(asTaskStatus('pending')).toBe('pending')
    expect(() => asTaskStatus('nope')).toThrow()
    expect(() => asCursorMcpConfigPatch({ a: 'x'.repeat(250_000) })).toThrow(/max size/)
  })
})
