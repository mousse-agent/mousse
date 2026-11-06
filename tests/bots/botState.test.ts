import { describe, expect, it } from 'vitest'
import { botState } from '../../src/shared/bots/personal/state'

const error = { text: 'Gmail sign-in expired', action: { kind: 'sign_in' as const, label: 'Sign in again' } }

describe('bot state', () => {
  it('is idle with nothing going on', () => {
    expect(botState({ paused: false, openAsks: 0, liveActivations: 0 })).toBe('idle')
  })

  it('is working while an activation is queued or running', () => {
    expect(botState({ paused: false, openAsks: 0, liveActivations: 2 })).toBe('working')
  })

  it('needs you with an open ask, even while working', () => {
    expect(botState({ paused: false, openAsks: 1, liveActivations: 1 })).toBe('needs_you')
  })

  it('is stuck with an error, ahead of asks and work', () => {
    expect(botState({ paused: false, error, openAsks: 1, liveActivations: 1 })).toBe('stuck')
  })

  it('is paused ahead of everything else', () => {
    expect(botState({ paused: true, error, openAsks: 1, liveActivations: 1 })).toBe('paused')
    expect(botState({ paused: true, openAsks: 0, liveActivations: 0 })).toBe('paused')
  })
})
