/** SPEC §16.1 budget and history selection. */
import { describe, expect, it } from 'vitest'
import {
  COMPACTED_ITEM_CHARS,
  DEFAULT_HANDOFF_TOKEN_CAP,
  compactText,
  handoffBudget,
  handoffTokenCap,
  recoveryPointer,
  selectHistory,
  type HandoffItem
} from '../../src/mms/run/handoff/budget'

const user = (runOrdinal: number, text: string): HandoffItem => ({ runOrdinal, role: 'user', text })
const assistant = (runOrdinal: number, text: string): HandoffItem => ({ runOrdinal, role: 'assistant', text })

describe('handoff budget (SPEC §16.1)', () => {
  it('reads MOUSSE_HANDOFF_TOKEN_CAP clamped to 1k–64k, defaulting to 16k', () => {
    expect(handoffTokenCap({})).toBe(DEFAULT_HANDOFF_TOKEN_CAP)
    expect(handoffTokenCap({ MOUSSE_HANDOFF_TOKEN_CAP: 'lots' })).toBe(16_000)
    expect(handoffTokenCap({ MOUSSE_HANDOFF_TOKEN_CAP: '20' })).toBe(1_000)
    expect(handoffTokenCap({ MOUSSE_HANDOFF_TOKEN_CAP: '999999' })).toBe(64_000)
    expect(handoffTokenCap({ MOUSSE_HANDOFF_TOKEN_CAP: '24000' })).toBe(24_000)
  })

  it('takes min(cap, window − native − current − reserve) with window capped at 128k and a 16k or quarter reserve', () => {
    // 128k window: reserve 32k; plenty left, so the cap wins.
    expect(handoffBudget({ cap: 16_000 })).toBe(16_000)
    expect(handoffBudget({ cap: 64_000, modelWindow: 1_000_000 })).toBe(64_000)
    // 200k is treated as 128k: 128k − 70k − 0 − 32k = 26k.
    expect(handoffBudget({ cap: 64_000, modelWindow: 200_000, nativeTokens: 70_000 })).toBe(26_000)
    // 32k window: reserve max(16k, 8k) = 16k; 32k − 4k − 2k − 16k = 10k.
    expect(handoffBudget({ cap: 64_000, modelWindow: 32_000, nativeTokens: 4_000, currentTokens: 2_000 })).toBe(10_000)
    // Never negative.
    expect(handoffBudget({ cap: 16_000, modelWindow: 20_000, currentTokens: 10_000 })).toBe(0)
  })

  it('reserves 8192 tokens per image and 4096 per other attachment of the current message', () => {
    const items = [user(1, 'old question')]
    const current: HandoffItem = { runOrdinal: 2, role: 'user', text: 'now', current: true, attachments: { images: 1, other: 1 } }
    const selection = selectHistory([...items, current], 8_192 + 4_096 + 3)
    expect(selection.selected.map((item) => item.text)).toEqual(['now'])
    expect(selection.omitted.map((item) => item.text)).toEqual(['old question'])
    expect(selection.usedTokens).toBe(8_192 + 4_096 + 3)
  })

  it('selects last user, last assistant, first user, then newest first', () => {
    const items = [
      user(1, 'u1-first'), assistant(1, 'a1'), user(2, 'u2'), assistant(2, 'a2'), user(3, 'u3-last'), assistant(3, 'a3-last')
    ]
    // Each item is ≤ 8 bytes; a budget of 30 fits four of them whole.
    const budget = ['u3-last', 'a3-last', 'u1-first', 'a2'].reduce((sum, text) => sum + text.length, 0)
    const selection = selectHistory(items, budget)
    expect(selection.selected.map((item) => item.text)).toEqual(['u1-first', 'a2', 'u3-last', 'a3-last'])
    expect(selection.omitted.map((item) => item.text)).toEqual(['a1', 'u2'])
    expect(selection.selected.every((item) => !item.compacted)).toBe(true)
  })

  it('compacts items that do not fit whole to at most 240 characters, after the whole items', () => {
    const long = 'x'.repeat(5_000)
    const items = [user(1, long), assistant(1, 'short answer'), user(2, 'follow-up')]
    const selection = selectHistory(items, 'follow-up'.length + 'short answer'.length + Buffer.byteLength(compactText(long)))
    const first = selection.selected.find((item) => item.index === 0)!
    expect(first.compacted).toBe(true)
    expect([...first.text].length).toBeLessThanOrEqual(COMPACTED_ITEM_CHARS)
    expect(first.text.endsWith('…')).toBe(true)
    expect(selection.selected.map((item) => item.index)).toEqual([0, 1, 2])
    expect(compactText('short')).toBe('short')
  })

  it('never truncates or drops the current user message, even over budget', () => {
    const current: HandoffItem = { runOrdinal: 4, role: 'user', text: 'y'.repeat(10_000), current: true }
    const selection = selectHistory([user(1, 'older'), current], 10)
    expect(selection.selected).toEqual([{ ...current, index: 1, compacted: false }])
    expect(selection.omitted.map((item) => item.text)).toEqual(['older'])
  })

  it('points at thread_read with the omitted run range, and says nothing when nothing was omitted', () => {
    expect(recoveryPointer([], 'thread-1')).toBe('')
    const pointer = recoveryPointer([{ runOrdinal: 2 }, { runOrdinal: 5 }, { runOrdinal: null }], 'thread-1')
    expect(pointer).toContain('thread_read')
    expect(pointer).toContain('runs 2–5')
    expect(pointer).toContain('3 earlier item(s)')
    expect(pointer).toContain('"threadId":"thread-1"')
    expect(recoveryPointer([{ runOrdinal: 7 }], 't')).toContain('run 7 of thread t')
  })
})
