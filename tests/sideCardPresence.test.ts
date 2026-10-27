import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SIDE_CARD_FADE_MS,
  createSideCardPresence,
  nextSideCardPhase,
  sideCardPresenceView,
  type SideCardPhase
} from '../src/renderer/components/sideCard/sideCardPresence'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('nextSideCardPhase', () => {
  it('fades in: unmounted, entering, then shown once painted', () => {
    const entering = nextSideCardPhase('unmounted', { type: 'present', animate: true })
    expect(entering).toBe('entering')
    expect(nextSideCardPhase(entering, { type: 'painted' })).toBe('shown')
  })

  it('appears shown straight away when not animating', () => {
    expect(nextSideCardPhase('unmounted', { type: 'present', animate: false })).toBe('shown')
  })

  it('fades out: shown, exiting, then unmounted once faded', () => {
    const exiting = nextSideCardPhase('shown', { type: 'absent' })
    expect(exiting).toBe('exiting')
    expect(nextSideCardPhase(exiting, { type: 'faded' })).toBe('unmounted')
  })

  it('drops a card that never faded in without waiting', () => {
    expect(nextSideCardPhase('entering', { type: 'absent' })).toBe('unmounted')
  })

  it('reverses an exit when the card is wanted again', () => {
    expect(nextSideCardPhase('exiting', { type: 'present', animate: true })).toBe('shown')
  })

  it('ignores events that do not apply to the phase', () => {
    const cases: [SideCardPhase, Parameters<typeof nextSideCardPhase>[1]][] = [
      ['unmounted', { type: 'absent' }],
      ['unmounted', { type: 'painted' }],
      ['unmounted', { type: 'faded' }],
      ['entering', { type: 'present', animate: true }],
      ['entering', { type: 'faded' }],
      ['shown', { type: 'present', animate: true }],
      ['shown', { type: 'painted' }],
      ['shown', { type: 'faded' }],
      ['exiting', { type: 'absent' }],
      ['exiting', { type: 'painted' }]
    ]
    for (const [phase, event] of cases) expect(nextSideCardPhase(phase, event)).toBe(phase)
  })
})

describe('sideCardPresenceView', () => {
  it.each<[SideCardPhase, { mounted: boolean; shown: boolean; reserved: boolean }]>([
    ['unmounted', { mounted: false, shown: false, reserved: false }],
    ['entering', { mounted: true, shown: false, reserved: true }],
    ['shown', { mounted: true, shown: true, reserved: true }],
    // Room for the card is released as the fade starts, so the transcript moves with it.
    ['exiting', { mounted: true, shown: false, reserved: false }]
  ])('%s', (phase, view) => {
    expect(sideCardPresenceView(phase)).toEqual(view)
  })
})

describe('createSideCardPresence', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (initial: SideCardPhase = 'unmounted') => {
    const phases: SideCardPhase[] = []
    const presence = createSideCardPresence((phase) => phases.push(phase), initial)
    return { presence, phases }
  }

  it('mounts faded out, then fades in after the faded-out styles have painted', () => {
    const { presence, phases } = setup()
    presence.setPresent(true)
    expect(presence.phase).toBe('entering')
    vi.advanceTimersByTime(8)
    expect(presence.phase).toBe('entering')
    vi.advanceTimersByTime(40)
    expect(presence.phase).toBe('shown')
    expect(phases).toEqual(['entering', 'shown'])
  })

  it('stays mounted for the whole fade-out, then unmounts', () => {
    const { presence, phases } = setup('shown')
    presence.setPresent(false)
    expect(presence.phase).toBe('exiting')
    vi.advanceTimersByTime(SIDE_CARD_FADE_MS - 1)
    expect(presence.phase).toBe('exiting')
    vi.advanceTimersByTime(1)
    expect(presence.phase).toBe('unmounted')
    expect(phases).toEqual(['exiting', 'unmounted'])
  })

  it('keeps the exit wait and fade-in whatever the motion preference, which only changes the styling', () => {
    // The controller has no motion input: reduced motion shares these timings and fades opacity only.
    const { presence } = setup('shown')
    presence.setPresent(false)
    vi.advanceTimersByTime(SIDE_CARD_FADE_MS / 2)
    expect(sideCardPresenceView(presence.phase).mounted).toBe(true)
    vi.advanceTimersByTime(SIDE_CARD_FADE_MS / 2)
    expect(sideCardPresenceView(presence.phase).mounted).toBe(false)
  })

  it('cancels the pending unmount when the card comes back mid-fade', () => {
    const { presence, phases } = setup('shown')
    presence.setPresent(false)
    vi.advanceTimersByTime(SIDE_CARD_FADE_MS / 2)
    presence.setPresent(true)
    expect(presence.phase).toBe('shown')
    vi.advanceTimersByTime(SIDE_CARD_FADE_MS * 2)
    expect(presence.phase).toBe('shown')
    expect(phases).toEqual(['exiting', 'shown'])
  })

  it('does not fade in a card that left before it painted', () => {
    const { presence, phases } = setup()
    presence.setPresent(true)
    presence.setPresent(false)
    expect(presence.phase).toBe('unmounted')
    vi.advanceTimersByTime(SIDE_CARD_FADE_MS * 2)
    expect(phases).toEqual(['entering', 'unmounted'])
  })

  it('appears at once without a fade-in when told not to animate', () => {
    const { presence, phases } = setup()
    presence.setPresent(true, false)
    expect(presence.phase).toBe('shown')
    vi.advanceTimersByTime(SIDE_CARD_FADE_MS)
    expect(phases).toEqual(['shown'])
  })

  it('reports nothing for a repeated request', () => {
    const { presence, phases } = setup('shown')
    presence.setPresent(true)
    presence.setPresent(true, false)
    expect(phases).toEqual([])
  })

  it('resumes an exit that was in flight when the previous controller was disposed', () => {
    const first = setup('shown')
    first.presence.setPresent(false)
    first.presence.dispose()
    const second = setup(first.presence.phase)
    vi.advanceTimersByTime(SIDE_CARD_FADE_MS)
    expect(second.presence.phase).toBe('unmounted')
    expect(first.phases).toEqual(['exiting'])
  })

  it('stops its timers when disposed', () => {
    const { presence, phases } = setup('shown')
    presence.setPresent(false)
    presence.dispose()
    vi.advanceTimersByTime(SIDE_CARD_FADE_MS * 2)
    expect(phases).toEqual(['exiting'])
  })
})

/** Specificity as the number of class, attribute and pseudo-class parts; :not() counts its argument. */
function classWeight(selector: string): number {
  const flat = selector.replace(/::[\w-]+/g, '').replace(/:not\(([^)]*)\)/g, ' $1 ')
  return (flat.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length
}

describe('side card stylesheet', () => {
  const css = read('../src/renderer/components/sideCard/sideCard.css')
  const global = read('../src/renderer/styles/global.css')

  it('keeps an opacity-only fade under reduced motion that beats the app-wide rule', () => {
    const globalSelector = /@media \(prefers-reduced-motion: reduce\) \{\s*(\*:not[^,{]+)/.exec(global)?.[1]
    expect(globalSelector).toBeTruthy()
    expect(global).toMatch(/transition-duration: 0\.01ms !important/)

    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    const rule = /([^{}]+)\{([^}]*transition-duration: 180ms !important[^}]*)\}/.exec(block)
    expect(rule).toBeTruthy()
    const [, selector, body] = rule!
    expect(body).toContain('transition-property: opacity')
    expect(body).toContain('transform: none')
    expect(classWeight(selector)).toBeGreaterThan(classWeight(globalSelector!))
    expect(selector).toContain('.thread-side-card')
  })

  it('matches the fade duration the presence logic waits for', () => {
    expect(SIDE_CARD_FADE_MS).toBe(180)
    expect(css).toContain('transition: opacity 180ms ease, transform 180ms ease;')
    expect(css).toMatch(/\.sidebar\.sidebar-full \.chat-input-area \{[^}]*transition: width 180ms ease, margin-left 180ms ease;/)
  })

  it('lifts the aside above the incoming app panel only while a card is mounted in a narrowed aside', () => {
    expect(css).toMatch(/\.sidebar:not\(\.sidebar-full\):has\(> \.thread-side-card-layer > \.thread-side-card\) \{\s*z-index: 1;/)
  })

  it('leaves section headings in sentence case', () => {
    const title = /\.side-card-section-title \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(title).toContain('font-size')
    expect(title).not.toMatch(/text-transform|letter-spacing/)
  })
})
