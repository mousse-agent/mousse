/**
 * Bot tags (shared/botLink.ts) and their chips in a bot's composer (lib/composerBotChips.ts): which written tags become
 * chips, and that every chip goes back out as the exact tag of its bot.
 */
import { describe, expect, it } from 'vitest'
import { botTag, parseBotLink } from '../../src/shared/botLink'
import { attachmentChipTokenFor } from '../../src/renderer/lib/composerAttachmentChips'
import { botChipTokenFor, chipBotTags, expandBotChips, findBotChips, matchTaggableBots, type BotChipEntry, type BotChipRegistry } from '../../src/renderer/lib/composerBotChips'
import { DEFAULT_BOT_LOOK } from '../../src/shared/bots/personal/look'

const KNOWN: Record<string, string> = { coxy: 'Coxy', twin: 'Coxy' }

/** Chips `text`'s tags of known bots into a fresh registry, then expands them again. */
function roundTrip(text: string) {
  const registry: BotChipRegistry = new Map()
  const register = (entry: BotChipEntry) => {
    const token = botChipTokenFor(entry, registry)
    registry.set(token, entry)
    return token
  }
  const chipped = chipBotTags(text, (botId) => KNOWN[botId] ?? null, register)
  return { chips: findBotChips(chipped.value, registry), back: expandBotChips(chipped.value, registry), registry, value: chipped.value }
}

describe('bot tags', () => {
  it.each([
    ['mousse://bot/coxy', 'coxy'],
    ['mousse://bot/bot_1-a/', 'bot_1-a'],
    ['MOUSSE://BOT/coxy', 'coxy'],
    ['mousse://bot/', null],
    ['mousse://bot/a b', null],
    ['mousse://thread/coxy', null]
  ])('%s names bot %s', (link, botId) => {
    expect(parseBotLink(link)).toBe(botId)
  })

  it('writes a name that can not end the link early, and keeps the rest of it, as bot_send takes it', () => {
    expect(botTag('coxy', 'Co[x]y\nTwo')).toBe('[@Co x y Two](mousse://bot/coxy)')
    expect(botTag('coxy', 'Alpha (dev)')).toBe('[@Alpha (dev)](mousse://bot/coxy)')
  })
})

describe('bot chips', () => {
  // [what, text, bots chipped, in order]
  const cases: Array<[string, string, string[]]> = [
    ['a tag of a known bot', 'ask [@Coxy](mousse://bot/coxy) now', ['coxy']],
    ['a tag in inline code stays text', 'write `[@Coxy](mousse://bot/coxy)` like this', []],
    ['a tag of a bot that is gone stays text', 'ask [@Old](mousse://bot/gone)', []],
    ['two bots of one name each keep their own', '[@Coxy](mousse://bot/coxy) and [@Coxy](mousse://bot/twin)', ['coxy', 'twin']],
    ['a plain @name is no tag', 'ask @Coxy now', []]
  ]
  it.each(cases)('%s', (_what, text, bots) => {
    const { chips, back } = roundTrip(text)
    expect(chips.map((chip) => chip.botId)).toEqual(bots)
    // Sent, copied or saved, the text is the tags as written.
    expect(back).toBe(text)
  })

  it('never reads an attachment chip of the same name as a bot', () => {
    const { registry } = roundTrip('[@Coxy](mousse://bot/coxy)')
    const file = attachmentChipTokenFor({ key: 'file:1', name: 'Coxy', kind: 'file' }, new Map())
    expect(findBotChips(`see ${file}`, registry)).toEqual([])
  })

  it('lists bots whose name starts with what is typed before those that hold it', () => {
    const bot = (id: string, name: string) => ({ id, name, look: DEFAULT_BOT_LOOK })
    const bots = [bot('a', 'Decoy'), bot('b', 'Coxy'), bot('c', 'Pippy')]
    expect(matchTaggableBots(bots, 'co').map((entry) => entry.name)).toEqual(['Coxy', 'Decoy'])
    expect(matchTaggableBots(bots, '').map((entry) => entry.name)).toEqual(['Decoy', 'Coxy', 'Pippy'])
  })
})
