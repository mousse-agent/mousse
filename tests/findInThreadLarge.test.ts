import { readFileSync } from 'node:fs'
import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { FindIndex, buildFindIndex, formatFindCount, type FindTurn } from '../src/renderer/chat/components/agent-elements/find/find-index'
import { indexOrder, startIsSettled } from '../src/renderer/chat/components/agent-elements/find/use-thread-find'

const message = (id: string, role: 'user' | 'assistant', text: string): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text }] }) as unknown as UIMessage

const paragraph = (i: number) =>
  `Paragraph ${i} explains the **render loop** and the \`scheduler\`, with a [link](https://x.test) and more words to pad it out. `.repeat(3)

/** 2,000 messages, about 3.7 million characters: a prompt and an eight-paragraph reply with a code block per turn. */
function longThread(messages = 2000): FindTurn[] {
  return Array.from({ length: messages / 2 }, (_, t) => ({
    key: `t${t}`,
    userMsg: message(`u${t}`, 'user', `Question ${t}: why does the render loop stall?`),
    assistantMsgs: [
      message(
        `a${t}`,
        'assistant',
        Array.from({ length: 8 }, (_, k) => paragraph(t * 8 + k)).join('\n\n') + `\n\n\`\`\`ts\nconst value = compute(${t})\n\`\`\`\n`
      )
    ]
  }))
}

describe('find on a long thread', () => {
  const turns = longThread()
  const all = turns.flatMap((turn) => [turn.userMsg!, ...turn.assistantMsgs])
  // The other cases need no 3.7 MB build: the same shape, 200 messages.
  const short = longThread(200)
  const shortAll = short.flatMap((turn) => [turn.userMsg!, ...turn.assistantMsgs])

  it('builds the index in slices, then answers every keystroke from it', () => {
    const index = new FindIndex()
    let slices = 0
    for (let done = false; !done; slices++) done = index.indexSome(all, 8)
    // 3.7 million characters do not fit one 8 ms slice: the build gives the renderer frames in between.
    expect(slices).toBeGreaterThan(1)
    expect(index.missing(turns, 1)).toBe(0)

    for (const query of ['r', 're', 'ren', 'rend', 'render', 'render l', 'render lo', 'render loop', 'compute(77']) {
      expect(index.search(turns, query, { readMissing: false }).matches.length, query).toBeGreaterThan(0)
    }
    expect(index.search(turns, 'zzz', { readMissing: false }).matches).toEqual([])
    expect(index.search(turns, 'compute(777)', { readMissing: false }).matches.map((match) => match.turnKey)).toEqual(['t777'])
  })

  it('reads again only the message that changed, as a streaming reply does', () => {
    const index = new FindIndex()
    index.indexSome(shortAll, Number.POSITIVE_INFINITY)
    const before = index.revision
    const last = short[short.length - 1]!
    const streamed: FindTurn[] = [
      ...short.slice(0, -1),
      { ...last, assistantMsgs: [message('a99', 'assistant', `${(last.assistantMsgs[0]!.parts[0] as { text: string }).text}\n\nA fresh needle.`)] }
    ]
    expect(index.missing(streamed, 10)).toBe(1)
    const { matches, complete } = index.search(streamed, 'fresh needle')
    expect(complete).toBe(true)
    expect(matches).toHaveLength(1)
    expect(index.revision - before).toBe(1)
    // The same text in a new message object is not read again.
    const copied: FindTurn[] = streamed.map((turn) => ({ ...turn, assistantMsgs: turn.assistantMsgs.map((m) => ({ ...m }) as UIMessage) }))
    index.search(copied, 'needle')
    expect(index.revision - before).toBe(1)
  })

  it('matches the one-off search, block for block and offset for offset', () => {
    const index = new FindIndex()
    const sample = short.slice(0, 40)
    expect(index.search(sample, 'Render').matches).toEqual(buildFindIndex(sample, 'Render'))
    // No match spans two blocks (the last paragraph and the code block), even though the index joins them.
    expect(index.search(sample, 'out. const value').matches).toEqual([])
    expect(index.search(sample, 'const value').matches).toHaveLength(40)
  })

  it('searches the part read so far while the build runs, and says so', () => {
    const index = new FindIndex()
    // The build reads from the view (turn 60) down first; here it has read that far and no further.
    index.indexSome(short.slice(60).flatMap((turn) => [turn.userMsg!, ...turn.assistantMsgs]), Number.POSITIVE_INFINITY)
    const partial = index.search(short, 'compute(60)', { readMissing: false })
    expect(partial.complete).toBe(false)
    expect(partial.matches.map((match) => match.turnKey)).toEqual(['t60'])
    expect(startIsSettled(index, short, 60, partial.matches[0]!)).toBe(true)
    expect(startIsSettled(index, short, 59, partial.matches[0]!)).toBe(false)
    expect(formatFindCount(0, 1, 'x', true)).toBe('1 of 1…')
    expect(formatFindCount(null, 0, 'x', true)).toBe('Searching…')
  })

  it('reads the turns from the view down first, then back up', () => {
    const order = [...indexOrder(turns.slice(0, 4), 2)].map((m) => m.id)
    expect(order).toEqual(['u2', 'a2', 'u3', 'a3', 'u1', 'a1', 'u0', 'a0'])
  })
})

describe('find bar placement', () => {
  const agentCss = readFileSync('src/renderer/chat/components/agent-elements/agent-ui.css', 'utf8')
  const cardCss = readFileSync('src/renderer/components/sideCard/sideCard.css', 'utf8')

  it('takes the top of the card column at the card width', () => {
    expect(agentCss).toMatch(
      /\.thread-side-card-layer > \.chat-find-bar \{\s*top: var\(--side-card-gutter\);\s*right: var\(--side-card-gutter\);\s*width: var\(--side-card-width\);/
    )
  })

  it('pushes an open card down by its height and a gap, animated, and back when it closes', () => {
    expect(cardCss).toMatch(
      /\.thread-side-card-layer:has\(> \.chat-find-bar\) > \.thread-side-card \{\s*translate: 0 calc\(var\(--chat-find-bar-height\) \+ var\(--chat-find-bar-gap\)\);/
    )
    expect(cardCss.match(/translate var\(--ui-dur-slow\) var\(--ui-collapse-ease\)/g)).toHaveLength(2)
    expect(agentCss).toMatch(/height: var\(--chat-find-bar-height, 34px\)/)
  })

  it('draws no focus border or ring on the field', () => {
    expect(agentCss).toMatch(
      /\.chat-find-bar \.chat-find-input,\s*\.chat-find-bar \.chat-find-input:focus,\s*\.chat-find-bar \.chat-find-input:focus-visible \{[^}]*border: 0;[^}]*outline: 0;[^}]*box-shadow: none;/
    )
  })
})
