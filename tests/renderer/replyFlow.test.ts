// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLOW_CATCH_UP_MS,
  FLOW_IDLE_MS,
  FLOW_TICK_MS,
  flowEnd,
  flowStepSize,
  nextFlowStep,
  quietEnd,
  useFlowingText
} from '../../src/renderer/chat/components/agent-elements/reply-flow'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('what of a streaming bot reply may show', () => {
  // Each row: the text so far, and the part that may show. Nothing shown may change shape when more text comes.
  const rows: Array<[string, string, string]> = [
    ['a word being written', 'The first dri', 'The first '],
    ['a whole text', 'The first drive. ', 'The first drive. '],
    ['one word, unfinished', 'The', ''],
    ['a bullet with no words yet', 'Steps:\n- ', 'Steps:\n'],
    ['a bullet with its first word unfinished', 'Steps:\n- on', 'Steps:\n'],
    ['a bullet with a whole word', 'Steps:\n- one tw', 'Steps:\n- one '],
    ['a number with no words yet', 'Steps:\n12. ', 'Steps:\n'],
    ['a heading mark alone', 'Intro.\n## ', 'Intro.\n'],
    ['a quote mark alone', 'Intro.\n> ', 'Intro.\n'],
    ['a line that could make the one above a heading', 'Title\n--', 'Title\n'],
    ['a table row still being written', '| a | b |\n|---|---|\n| 1 | 2', '| a | b |\n|---|---|\n'],
    ['a fence being opened', 'Run:\n```t', 'Run:\n'],
    ['a fence with no finished line yet', 'Run:\n```ts\nconst', 'Run:\n'],
    ['a line of code being written', 'Run:\n```ts\nconst a = 1\nconst b', 'Run:\n```ts\nconst a = 1\n'],
    ['words after a closed fence', '```\nx\n```\nThen we', '```\nx\n```\nThen '],
  ]
  it.each(rows)('%s', (_name, text, shown) => {
    expect(text.slice(0, flowEnd(text))).toBe(shown)
  })
})

describe('the flow toward what may show', () => {
  it('ends every step after a whole word, and catches up within its time however much is waiting', () => {
    for (const words of [3, 40, 400]) {
      const text = Array.from({ length: words }, (_, at) => `word${at}`).join(' ') + ' '
      const target = flowEnd(text)
      let shown = 0
      let steps = 0
      let size = 0
      while (shown < target) {
        size = flowStepSize(target - shown, size)
        shown = nextFlowStep(text, shown, target, size)
        steps++
        expect(/\s/.test(text[shown - 1]!)).toBe(true)
      }
      expect(steps).toBeLessThanOrEqual(FLOW_CATCH_UP_MS / FLOW_TICK_MS + 1)
    }
  })

  it('never stops a step where the text could not show on its own, such as just after a list bullet', () => {
    const text = 'Here is what stood out:\n- Sequential read is close.\n- Sustained write: the WD keeps up.\n\n```ts\nconst a = 1\n```\nDone. '
    const target = flowEnd(text)
    for (const size of [1, 3, 9]) {
      for (let shown = 0; shown < target;) {
        shown = nextFlowStep(text, shown, target, size)
        expect(flowEnd(text.slice(0, shown))).toBe(shown)
      }
    }
  })
})

describe('what of a paused reply may show', () => {
  // A last word with no white space after it shows only when it ends a sentence or clause; a lone mark does not.
  const rows: Array<[string, string]> = [
    ['Below $140?', 'Below $140?'],
    ['I checked it.', 'I checked it.'],
    ['The tests pa', 'The tests '],
    ['The *', 'The '],
    ['Steps:\n1.', 'Steps:\n'],
  ]
  it.each(rows)('%j', (text, shown) => {
    expect(text.slice(0, quietEnd(text))).toBe(shown)
  })
})

describe('useFlowingText', () => {
  let container: HTMLDivElement
  let root: Root
  let shown = ''
  function Probe({ text, flowing, flowKey }: { text: string; flowing: boolean; flowKey?: string }) {
    shown = useFlowingText(text, flowing, flowKey)
    return null
  }
  const render = (text: string, flowing = true, flowKey?: string) => act(() => root.render(createElement(Probe, { text, flowing, flowKey })))
  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    act(() => setAnimationSpeed('normal'))
    vi.useRealTimers()
  })

  it('flows whole words in; once the text stops, shows a last word that ends a sentence, never one cut off', async () => {
    await render('Checked the build and the tests pa')
    await wait(FLOW_TICK_MS)
    expect('Checked the build and the tests '.startsWith(shown)).toBe(true)
    expect(shown.length).toBeLessThan('Checked the build and the tests '.length)
    await wait(FLOW_CATCH_UP_MS)
    expect(shown).toBe('Checked the build and the tests ')
    // The model paused mid-word: the word waits, so it never shows cut off and then changes.
    await wait(FLOW_IDLE_MS + FLOW_CATCH_UP_MS)
    expect(shown).toBe('Checked the build and the tests ')
    // The reply's last word, ended by its stop: it shows once nothing more comes.
    await render('Checked the build and the tests pass.')
    await wait(FLOW_CATCH_UP_MS)
    expect(shown).toBe('Checked the build and the tests ')
    await wait(FLOW_IDLE_MS + FLOW_CATCH_UP_MS)
    expect(shown).toBe('Checked the build and the tests pass.')
  })

  it('with Animation speed Off, shows whole words as they come, with no flow', async () => {
    act(() => setAnimationSpeed('off'))
    await render('Checked the build and the te')
    expect(shown).toBe('Checked the build and the ')
  })

  it('a new key starts the next reply from nothing, and shows its first word even when it is as long as the last step', async () => {
    await render('Hi ', true, 'first')
    await wait(FLOW_CATCH_UP_MS)
    expect(shown).toBe('Hi ')
    await render('Yo there ', true, 'second')
    expect(shown).toBe('')
    // Its first step comes at once.
    await wait(1)
    expect(shown).toBe('Yo ')
  })

  it('shows all of a reply that is no longer streaming', async () => {
    await render('Checked the bu', false)
    expect(shown).toBe('Checked the bu')
  })
})
