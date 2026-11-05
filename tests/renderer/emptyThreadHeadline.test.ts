// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { EmptyThreadHeading } from '../../src/renderer/components/EmptyThreadHeading'
import { EMPTY_THREAD_HEADLINES, daySlot, emptyThreadHeadline } from '../../src/renderer/utils/emptyThreadHeadline'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = (hour: number, minute = 0) => new Date(2026, 10, 6, hour, minute)

describe('the empty chat headline', () => {
  it('picks the slot by local hour', () => {
    const slots = Array.from({ length: 24 }, (_, hour) => daySlot(at(hour, 30)))
    expect(slots.map((slot, hour) => `${hour}:${slot}`)).toEqual([
      ...[0, 1, 2, 3, 4].map((hour) => `${hour}:lateNight`),
      ...[5, 6, 7, 8, 9, 10, 11].map((hour) => `${hour}:morning`),
      ...[12, 13, 14, 15, 16, 17].map((hour) => `${hour}:afternoon`),
      ...[18, 19, 20, 21, 22].map((hour) => `${hour}:evening`),
      '23:lateNight'
    ])
  })

  it.each([
    ['morning', 8],
    ['afternoon', 14],
    ['evening', 20],
    ['lateNight', 2]
  ] as const)('gives a %s line at %i:00', (slot, hour) => {
    const seeds = Array.from({ length: 40 }, (_, index) => `thread-${index}`)
    const lines = new Set(seeds.map((seed) => emptyThreadHeadline(at(hour), seed)))
    for (const line of lines) expect(EMPTY_THREAD_HEADLINES[slot]).toContain(line)
    // Different chats can get different lines.
    expect(lines.size).toBeGreaterThan(1)
  })

  it('is the same line for the same chat', () => {
    for (const seed of ['thread-a', 'thread-b', '__blank__']) {
      expect(emptyThreadHeadline(at(9, 1), seed)).toBe(emptyThreadHeadline(at(11, 59), seed))
    }
  })

  it('keeps every line short, plain and calm', () => {
    for (const line of Object.values(EMPTY_THREAD_HEADLINES).flat()) {
      expect(line.length).toBeLessThanOrEqual(40)
      expect(line).not.toContain('!')
      expect(line).toMatch(/^[\x20-\x7e]+$/)
    }
  })
})

describe('an empty chat', () => {
  let root: Root | undefined
  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  it('shows the logo and a headline', () => {
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    act(() => root!.render(createElement(EmptyThreadHeading, { headline: "What's next?" })))
    expect(host.querySelector('.chat-empty-logo[role="img"][aria-label="Mousse"] svg')).not.toBeNull()
    expect(host.querySelector('h1.chat-empty-title')?.textContent).toBe("What's next?")
  })

  it('renders them above the composer, picked once per chat', () => {
    const chat = readFileSync(resolve(__dirname, '../../src/renderer/components/OrchestratorChat.tsx'), 'utf8')
    expect(chat).toContain('{emptyThread && <EmptyThreadHeading headline={emptyHeadline} />}')
    expect(chat.indexOf('<EmptyThreadHeading')).toBeLessThan(chat.indexOf('<ComposerWorkspaceToolbar'))
    expect(chat).toMatch(/useMemo\(\(\) => emptyThreadHeadline\(new Date\(\), activeThreadId \?\? '__blank__'\), \[activeThreadId\]\)/)
  })
})
