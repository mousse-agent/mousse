import { describe, expect, it } from 'vitest'
import { describePausedRun, pausedActionError, pausedStatusLabel, pausedUntilLabel } from '../../src/renderer/lib/pausedRun'
import { formatPauseUntil, formatTimeUntil, pauseProviderName, pauseWindowLabel } from '../../src/shared/pauseDisplay'
import { chatStatusFromPhase } from '../../src/renderer/chat/types/ui'
import type { TurnPause } from '../../src/shared/types'

// Local wall-clock times, so the expectations hold in any time zone.
const at = (hours: number, minutes = 0, day = 27) => new Date(2026, 9, day, hours, minutes).getTime()
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const pause = (patch: Partial<TurnPause> = {}): TurnPause => ({
  runId: 'run:1',
  until: new Date(at(15, 40)).toISOString(),
  estimated: false,
  autoResume: true,
  provider: 'claude',
  limitKind: 'five_hour',
  ...patch
})

describe('formatTimeUntil', () => {
  const now = at(13, 25)
  it.each([
    [at(15, 40), '2h 15m'],
    [at(14, 25), '1h'],
    [at(13, 55), '30m'],
    [now + 30_000, 'under a minute'],
    [at(13, 25, 30), '3d'],
    [at(17, 25, 29), '2d 4h']
  ])('%#: the time left', (until, expected) => {
    expect(formatTimeUntil(new Date(until).toISOString(), now)).toBe(expected)
  })

  it('says nothing once the time has passed or is not a time', () => {
    expect(formatTimeUntil(new Date(now).toISOString(), now)).toBeUndefined()
    expect(formatTimeUntil(new Date(now - 1000).toISOString(), now)).toBeUndefined()
    expect(formatTimeUntil('later', now)).toBeUndefined()
  })
})

describe('formatPauseUntil', () => {
  it('shows the clock time today and adds the date for another day', () => {
    expect(formatPauseUntil(new Date(at(15, 40)).toISOString(), at(13, 25))).toBe(clock(at(15, 40)))
    const tomorrow = formatPauseUntil(new Date(at(15, 40, 28)).toISOString(), at(13, 25))
    expect(tomorrow).toContain(clock(at(15, 40, 28)))
    expect(tomorrow).not.toBe(clock(at(15, 40, 28)))
    expect(formatPauseUntil('not a time')).toBe('not a time')
  })

  it('names the provider and the window the way the failure text does', () => {
    expect(pauseProviderName('claude')).toBe('Claude')
    expect(pauseProviderName('openai-codex')).toBe('ChatGPT')
    expect(pauseProviderName('acme')).toBe('acme')
    expect(pauseWindowLabel('five_hour')).toBe('5-hour')
    expect(pauseWindowLabel('seven_day_opus')).toBe('7-day Opus')
    expect(pauseWindowLabel(undefined)).toBeUndefined()
  })
})

describe('describePausedRun', () => {
  const now = at(13, 25)

  it('a timer is armed: the reset time, the time left, the limit, and that it continues by itself', () => {
    const text = describePausedRun(pause(), now)
    expect(text).toEqual({
      headline: `Paused until ${clock(at(15, 40))}`,
      relative: 'Resets in 2h 15m',
      detail: "Claude's 5-hour limit was reached. Continues by itself at reset.",
      due: false,
      stale: false
    })
  })

  it('labels a time Mousse guessed as estimated', () => {
    expect(describePausedRun(pause({ estimated: true }), now).headline).toBe(`Paused until ${clock(at(15, 40))} (estimated)`)
    expect(pausedUntilLabel({ until: pause().until, estimated: false }, now)).toBe(`Paused until ${clock(at(15, 40))}`)
  })

  it('names what it can when the provider or window is unknown', () => {
    expect(describePausedRun(pause({ limitKind: undefined }), now).detail).toContain("Claude's usage limit was reached.")
    expect(describePausedRun(pause({ provider: undefined, limitKind: undefined }), now).detail).toContain('The usage limit was reached.')
    expect(describePausedRun(pause({ provider: 'openai', limitKind: 'seven_day' }), now).detail).toContain("OpenAI's 7-day limit was reached.")
  })

  it('with no timer it says so and points at Resume now', () => {
    const text = describePausedRun(pause({ autoResume: false }), now)
    expect(text.detail).toBe("Claude's 5-hour limit was reached. It won't continue by itself. Press Resume now once it resets.")
    expect(text.stale).toBe(false)
  })

  it('after the reset time: an armed pause continues shortly, one without a timer waits for Resume now', () => {
    const later = at(16, 10)
    const armed = describePausedRun(pause(), later)
    expect(armed).toMatchObject({ due: true, stale: false, detail: 'Claude\'s 5-hour limit was reached. The limit should have reset, so it continues shortly.' })
    expect(armed.relative).toBeUndefined()
    const manual = describePausedRun(pause({ autoResume: false }), later)
    expect(manual).toMatchObject({ due: true, stale: false, detail: "Claude's 5-hour limit was reached. The limit should have reset. Press Resume now to continue." })
  })

  it('a stale pause says it will not continue by itself', () => {
    const text = describePausedRun(pause({ autoResume: false, stale: true }), at(9, 0, 29))
    expect(text.stale).toBe(true)
    expect(text.detail).toBe("Claude's 5-hour limit was reached. The reset passed while Mousse was off, so it won't continue by itself. Press Resume now to continue.")
    expect(text.relative).toBeUndefined()
  })

  it('an armed timer more than a day past its reset is worded as stale before the daemon rules on it', () => {
    expect(describePausedRun(pause(), at(16, 0, 29)).stale).toBe(true)
    expect(describePausedRun(pause(), at(15, 0, 28)).stale).toBe(false)
    // Without a timer, being old is not the same as being stale.
    expect(describePausedRun(pause({ autoResume: false }), at(16, 0, 29)).stale).toBe(false)
  })
})

describe('the thread list', () => {
  const now = at(13, 25)
  it('says when a paused thread resets, marks a guess, and says just Paused for a row a subagent paused', () => {
    expect(pausedStatusLabel(pause(), now)).toBe(`Paused until ${clock(at(15, 40))}`)
    expect(pausedStatusLabel(pause({ estimated: true }), now)).toBe(`Paused until ~${clock(at(15, 40))}`)
    expect(pausedStatusLabel(undefined, now)).toBe('Paused')
  })

  it('a paused turn takes a new message in the composer', () => {
    expect(chatStatusFromPhase('paused')).toBe('ready')
  })
})

describe('pausedActionError', () => {
  it('a run that is no longer paused is the usual cause of a refusal', () => {
    expect(pausedActionError({ code: 'conflict', message: 'Run run:1 is not paused.' }, 'resume')).toBe('This run is no longer paused.')
    expect(pausedActionError({ code: 'conflict', message: 'x' }, 'cancel')).toBe('This run is no longer paused.')
  })

  it('any other failure names what was tried and why', () => {
    expect(pausedActionError({ code: 'internal', message: 'Daemon unavailable\nmore' }, 'resume')).toBe('Could not continue the run: Daemon unavailable')
    expect(pausedActionError(new Error('boom'), 'cancel')).toBe('Could not cancel the paused run: boom')
    expect(pausedActionError('nope', 'stop')).toBe('Could not stop the thread. Try again.')
  })
})
