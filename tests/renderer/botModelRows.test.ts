// @vitest-environment jsdom
/**
 * The shared model rows (#673) as New bot will host them: controlled by the store's draft, with every row Automatic
 * until one is picked, and Create bot carrying the rows to `bots.create`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotModelSlots } from '../../src/shared/bots/personal/definition'
import { AUTOMATIC_SLOTS } from '../../src/shared/bots/personal/modelSlots'
import { fakeBots, installPreload, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { BotModelRows, botLevelOptions, botPickOptions } = await import('../../src/renderer/components/bots/BotRunsOn')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

const OPTIONS = [
  { instanceId: 'claude', entry: 'Claude Code', model: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { instanceId: 'pi:key', entry: 'Anthropic API', model: 'opus', label: 'Opus', efforts: ['low', 'high'] }
]

let root: Root
let host: HTMLElement
let fake: FakeBots
const botsInitial = useBotsStore.getInitialState()
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }

/** New bot's Runs on, as the dialog will host it: the draft's rows, Automatic until picked. */
function NewBotRows() {
  const slots = useBotsStore((s) => s.newBotDraft.slots)
  return createElement(BotModelRows, { name: 'New bot', options: OPTIONS, slots: slots ?? AUTOMATIC_SLOTS, onChange: (next: BotModelSlots) => useBotsStore.getState().setNewBotDraft({ slots: next }) })
}

beforeEach(() => {
  fake = fakeBots()
  installPreload(fake)
  setBotsClient(fake.client)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setBotsClient(null)
  useBotsStore.setState(botsInitial)
})

describe('the model rows on New bot', () => {
  it('start Automatic; a pick goes into the draft, and Create bot sends the rows', async () => {
    await act(async () => root.render(createElement(NewBotRows)))
    expect(useBotsStore.getState().newBotDraft.slots).toBeNull()
    await click(host.querySelector('[aria-label="New bot\'s Talk model"]'))
    await click([...document.querySelectorAll('[role="option"]')].find((element) => element.textContent?.trim() === 'Opus'))
    const talk = { instanceId: 'claude', model: 'opus' }
    expect(useBotsStore.getState().newBotDraft).toMatchObject({ slots: { ...AUTOMATIC_SLOTS, talk }, touched: true })
    await act(async () => { await useBotsStore.getState().create({ look: { colour: 'teal', accessory: 'cap' }, description: 'Track my spending.', slots: useBotsStore.getState().newBotDraft.slots! }) })
    expect(fake.calls.find((entry) => entry[0] === 'create')?.[1]).toMatchObject({ slots: { ...AUTOMATIC_SLOTS, talk } })
    // Made: the draft starts empty again.
    expect(useBotsStore.getState().newBotDraft.slots).toBeNull()
  })

  it('names each entry, and offers a model\'s own reasoning levels after Default', () => {
    expect(botPickOptions(OPTIONS, null).map((option) => [option.label, option.group])).toEqual([['Automatic', undefined], ['Opus', 'Claude Code'], ['Opus', 'Anthropic API']])
    expect(botLevelOptions(OPTIONS, { instanceId: 'claude', model: 'opus' }).map((option) => option.label)).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high'])
    // A level the model no longer offers stays, so the picker shows what is saved.
    expect(botLevelOptions(OPTIONS, { instanceId: 'pi:key', model: 'opus', effort: 'medium' }).map((option) => option.label)).toEqual(['Default', 'Low', 'High', 'Medium'])
    expect(botPickOptions(OPTIONS, { instanceId: 'pi:gone', model: 'opus' }).at(-1)).toMatchObject({ label: 'opus', description: 'Not available now' })
  })
})
