// @vitest-environment jsdom
/**
 * About this bot (bot-ui §4.8): the whole mouse, the name and the description; Can use and Runs,
 * each item with a Remove that works; Pause and Delete. Nothing else.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AT, fakeBots, installPreload, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { BotAboutPanel, nextRunText, reminderWhenText } = await import('../../src/renderer/components/bots/BotAboutPanel')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

let root: Root
let host: HTMLElement
let fake: FakeBots
const botsInitial = useBotsStore.getInitialState()
const bot = summary('b1', { name: 'Inbox helper', description: 'Tells me which emails need a reply.', look: { colour: 'green', accessory: 'scarf' } })
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = async (element: Element | undefined) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }
const rows = (heading: string) => {
  const items: string[] = []
  let node = [...host.querySelectorAll('h3')].find((element) => element.textContent === heading)?.nextElementSibling
  while (node && node.classList.contains('bot-about-row')) { items.push(node.querySelector('span')!.textContent!); node = node.nextElementSibling }
  return items
}
async function show(current = bot) {
  fake.bots = [current]
  await act(async () => root.render(createElement(BotAboutPanel, { bot: current })))
  await act(async () => {})
}

beforeEach(() => {
  fake = fakeBots({
    details: {
      b1: {
        summary: bot,
        permissions: [
          { id: 'fp1', title: 'use files on this computer', note: "Read and change any file or folder, except Mousse's own data.", grantedAt: '2026-11-06T10:00:00.000Z' },
          { id: 'fp2', title: 'use the pdf skill', note: '', grantedAt: '2026-11-06T11:00:00.000Z' }
        ],
        runs: [{ id: 's1', label: 'every weekday · 09:00', kind: 'schedule' }]
      }
    }
  })
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

describe('About this bot', () => {
  it('shows the whole mouse, the name and the description', async () => {
    await show()
    const head = host.querySelector('.bot-about-head')!
    const face = head.querySelector('.bot-face')!
    expect(face.getAttribute('data-view')).toBe('full')
    expect(face.getAttribute('width')).toBe('88')
    expect(face.getAttribute('data-colour')).toBe('green')
    expect(head.querySelector('h2')?.textContent).toBe('Inbox helper')
    expect(head.querySelector('p')?.textContent).toBe('Tells me which emails need a reply.')
    expect([...host.querySelectorAll('h3')].map((element) => element.textContent)).toEqual(['CAN USE', 'RUNS', 'MEMORY', 'RUNS ON'])
  })

  it('with an older service (no rows): one Model picker, by usage until the owner picks a model by hand, on this computer (#673)', async () => {
    await show()
    // One computer: no Computer row (computer names show only with two or more).
    expect(rows('RUNS ON')).toEqual(['Model'])
    expect(host.querySelector('[data-testid="bot-about-model"]')?.textContent).toContain('By usage')
    await click(host.querySelector('[aria-label="Inbox helper\'s model"]') ?? undefined)
    const sonnet = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes('Claude · sonnet'))
    await click(sonnet)
    expect(fake.calls).toContainEqual(['setModel', 'b1', 'sonnet'])
    expect(host.querySelector('[data-testid="bot-about-model"]')?.textContent).toContain('Claude · sonnet')
  })

  describe('model rows (#673)', () => {
    const OPUS_SUB = { instanceId: 'claude', entry: 'Claude Code', model: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'] }
    const OPUS_KEY = { instanceId: 'pi:key', entry: 'Anthropic API', model: 'opus', label: 'Opus', efforts: ['low', 'high'] }
    const HAIKU = { instanceId: 'claude', entry: 'Claude Code', model: 'haiku', label: 'Haiku', efforts: [] }
    const AUTO = { talk: null, light: null, medium: null, hard: null }
    const withRows = (slots: object) => vi.mocked(fake.client.model).mockImplementation(async () => ({ model: null, slots, models: [], options: [OPUS_SUB, OPUS_KEY, HAIKU], computer: 'this_computer', computers: [{ id: 'this_computer', name: 'Desk' }] }) as never)
    const labels = () => [...host.querySelectorAll('.bot-model-row-label')].map((element) => element.textContent)
    const select = (label: string) => host.querySelector<HTMLElement>(`[aria-label="Inbox helper's ${label}"]`) ?? undefined
    const option = (text: string, group?: string) => {
      const options = [...document.querySelectorAll('[role="option"]')]
      if (!group) return options.find((element) => element.textContent?.trim() === text)
      // The option under a group heading (the entry).
      const heading = [...document.querySelectorAll('.ui-select-group')].find((element) => element.textContent === group)
      let node = heading?.nextElementSibling
      while (node && !node.classList.contains('ui-select-group')) {
        if (node.getAttribute('role') === 'option' && node.textContent?.trim() === text) return node
        node = node.nextElementSibling
      }
      return undefined
    }
    const lastSlots = () => fake.calls.filter((entry) => entry[0] === 'setSlots').at(-1)?.[2]

    it('Talk and Work, each Automatic until picked; the same model on two entries is told apart', async () => {
      withRows(AUTO)
      await show()
      expect(labels()).toEqual(['Talk', 'Work'])
      expect(select('Talk model')?.textContent).toContain('Automatic')
      // Automatic has no reasoning level to pick.
      expect(select('Talk reasoning level')).toBeUndefined()
      await click(select('Work model'))
      expect([...document.querySelectorAll('.ui-select-group')].map((element) => element.textContent)).toEqual(['Claude Code', 'Anthropic API'])
      await click(option('Opus', 'Anthropic API'))
      // Work is every level in the simple view.
      const onKey = { instanceId: 'pi:key', model: 'opus' }
      expect(lastSlots()).toEqual({ talk: null, light: onKey, medium: onKey, hard: onKey })
      // The model's name, and under it its entry, since the other entry offers the same model.
      expect([...(select('Work model')?.querySelectorAll('.bot-model-pick > *') ?? [])].map((element) => element.textContent)).toEqual(['Opus', 'Anthropic API'])
      // A model only one entry offers names no entry.
      await click(select('Talk model'))
      await click(option('Haiku'))
      expect([...(select('Talk model')?.querySelectorAll('.bot-model-pick > *') ?? [])].map((element) => element.textContent)).toEqual(['Haiku'])
      // Its reasoning levels: Default, then the model's own.
      await click(select('Work reasoning level'))
      expect([...document.querySelectorAll('[role="option"]')].map((element) => element.textContent?.trim())).toEqual(['Default', 'Low', 'High'])
      await click(option('High'))
      expect(lastSlots()).toEqual({ talk: { instanceId: 'claude', model: 'haiku' }, light: { ...onKey, effort: 'high' }, medium: { ...onKey, effort: 'high' }, hard: { ...onKey, effort: 'high' } })
    })

    it('Advanced shows each kind of work, opens by itself when they differ, and closing it puts Medium work on all work', async () => {
      const sub = { instanceId: 'claude', model: 'opus' }
      withRows({ talk: null, light: sub, medium: sub, hard: sub })
      await show()
      await click(host.querySelector('.bot-model-advanced [role="switch"]') ?? undefined)
      expect(labels()).toEqual(['Talk', 'Light work', 'Medium work', 'Hard work'])
      // Opening it saves nothing.
      expect(lastSlots()).toBeUndefined()
      await click(select('Hard work model'))
      await click(option('Haiku'))
      expect(lastSlots()).toEqual({ talk: null, light: sub, medium: sub, hard: { instanceId: 'claude', model: 'haiku' } })
      // A model with no levels to pick shows no level picker.
      expect(select('Hard work reasoning level')).toBeUndefined()
      await click(host.querySelector('.bot-model-advanced [role="switch"]') ?? undefined)
      expect(lastSlots()).toEqual({ talk: null, light: sub, medium: sub, hard: sub })
      expect(labels()).toEqual(['Talk', 'Work'])
    })

    it('rows that differ open Advanced; a pick not offered now stays, marked; a refused save goes back', async () => {
      withRows({ talk: { instanceId: 'pi:gone', model: 'opus' }, light: null, medium: { instanceId: 'claude', model: 'opus' }, hard: null })
      await show()
      expect(labels()).toEqual(['Talk', 'Light work', 'Medium work', 'Hard work'])
      expect(host.querySelector('.bot-model-advanced [role="switch"]')?.getAttribute('aria-checked')).toBe('true')
      await click(select('Talk model'))
      expect(option('opusNot available now')).toBeDefined()
      await click(option('Automatic'))
      vi.mocked(fake.client.setSlots).mockRejectedValueOnce({ code: 'model_unavailable', message: 'The model you picked is not available now. Pick another one, or Automatic.' })
      await click(select('Light work model'))
      await click(option('Opus', 'Anthropic API'))
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('The model you picked is not available now. Pick another one, or Automatic.')
      expect(select('Light work model')?.textContent).toContain('Automatic')
    })
  })

  it('lists the person’s other computers in Computer, greyed: a bot runs on the computer that holds it', async () => {
    vi.mocked(fake.client.model).mockImplementationOnce(async () => ({ model: null, models: [], computer: 'this_computer', computers: [{ id: 'this_computer', name: 'Desk' }, { id: 'nod_laptop', name: 'Laptop', offline: true, unavailable: 'Laptop is offline.' }] }))
    await show()
    expect(rows('RUNS ON')).toEqual(['Model', 'Computer'])
    expect(host.querySelector('[data-testid="bot-about-computer"]')?.textContent).toContain('Desk')
    await click(host.querySelector('[aria-label="Inbox helper\'s computer"]') ?? undefined)
    const laptop = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes('Laptop · offline'))
    expect(laptop?.getAttribute('aria-disabled')).toBe('true')
  })

  it('lists what it can use and removes one', async () => {
    await show()
    expect(rows('CAN USE')).toEqual(['Use files on this computer', 'Use the pdf skill'])
    await click(button('Remove use files on this computer'))
    expect(fake.calls).toContainEqual(['revokePermission', 'b1', 'fp1'])
    expect(rows('CAN USE')).toEqual(['Use the pdf skill'])
  })

  it('lists its runs and removes one', async () => {
    await show()
    expect(rows('RUNS')).toEqual(['Every weekday · 09:00'])
    await click(button('Remove every weekday · 09:00'))
    expect(fake.calls).toContainEqual(['removeSchedule', 'b1', 's1'])
    expect(rows('RUNS')).toEqual([])
    expect(host.textContent).toContain('Only when you message it. Ask it to run on a schedule.')
  })

  it('lists its waiting reminders under Runs with when each fires, and cancels one', async () => {
    const at = new Date(Date.now() + 2 * 60 * 60_000).toISOString()
    fake.details.b1 = { summary: bot, permissions: [], runs: [], reminders: [
      { id: 'rem_1', dueAt: at, text: 'Call mum.' },
      { id: 'rem_2', dueAt: at, text: 'Check the weather.', work: true }
    ] }
    await show()
    const reminders = [...host.querySelectorAll('[data-testid="bot-about-reminder"]')]
    expect(reminders.map((row) => row.querySelector('.bot-about-clamp')!.textContent)).toEqual(['Call mum.', 'Check the weather.'])
    expect(reminders[0]!.querySelector('.bot-about-next')!.textContent).toBe(`Reminds: ${reminderWhenText(at)}`)
    expect(reminders[1]!.querySelector('.bot-about-next')!.textContent).toBe(`Starts: ${reminderWhenText(at)}`)
    expect(host.textContent).not.toContain('Only when you message it.')
    await click(button('Cancel reminder: Call mum.'))
    expect(fake.calls).toContainEqual(['cancelReminder', 'b1', 'rem_1'])
    expect([...host.querySelectorAll('[data-testid="bot-about-reminder"] .bot-about-clamp')].map((row) => row.textContent)).toEqual(['Check the weather.'])
  })

  it('writes a reminder further than a week ahead with its date', () => {
    const now = new Date(2026, 10, 7, 8, 0)
    expect(reminderWhenText(new Date(2026, 10, 9, 9, 0).toISOString(), now)).toBe(nextRunText(new Date(2026, 10, 9, 9, 0).toISOString(), now))
    expect(reminderWhenText(new Date(2026, 10, 20, 9, 0).toISOString(), now)).toMatch(/20/)
    expect(reminderWhenText(new Date(2026, 10, 20, 9, 0).toISOString(), now)).not.toMatch(/^Fri /)
  })

  it('says how to get permissions and runs when there are none', async () => {
    fake.details.b1 = { summary: bot, permissions: [], runs: [] }
    await show()
    expect([...host.querySelectorAll('.bot-about-empty')].map((element) => element.textContent)).toEqual([
      'Nothing yet. It asks in the chat the first time it needs something.',
      'Only when you message it. Ask it to run on a schedule.',
      'Nothing yet. Tell it what to remember.'
    ])
  })

  it('lists what it remembers and forgets one with Remove', async () => {
    const entry = (id: string, text: string, status: 'active' | 'expired' = 'active') => ({ id, version: 1, ref: id, kind: 'owner' as const, text, since: AT, learnedAt: AT, by: 'you said' as const, status })
    fake.memory.b1 = [entry('m1', 'The owner wants no em dashes in my messages.'), entry('m2', 'The owner lives in London.'), entry('m3', 'On leave until 1 Nov 2026.', 'expired')]
    await show()
    // Only what every turn carries: an expired entry is not listed.
    expect(rows('MEMORY')).toEqual(['The owner wants no em dashes in my messages.', 'The owner lives in London.'])
    await click(button('Remove memory: The owner wants no em dashes in my messages.'))
    expect(fake.calls).toContainEqual(['forgetMemory', 'b1', 'm1'])
    expect(rows('MEMORY')).toEqual(['The owner lives in London.'])
  })

  it('reads its memory again when the bot changes, so an entry it just saved shows up', async () => {
    await show()
    expect(rows('MEMORY')).toEqual([])
    fake.memory.b1 = [{ id: 'm1', version: 1, ref: 'm1', kind: 'owner', text: 'Call the owner Sam.', since: AT, learnedAt: AT, by: 'you said', status: 'active' }]
    // A detail read over the bridge is a new object each time.
    fake.details.b1 = { ...fake.details.b1! }
    await act(async () => { await useBotsStore.getState().loadDetail('b1') })
    await act(async () => {})
    expect(rows('MEMORY')).toEqual(['Call the owner Sam.'])
  })

  it('pauses, resumes and asks before deleting', async () => {
    await show()
    await click(button('Pause'))
    expect(fake.calls).toContainEqual(['pause', 'b1'])
    await show({ ...bot, state: 'paused', stateText: 'Paused' })
    await click(button('Resume'))
    expect(fake.calls).toContainEqual(['resume', 'b1'])
    await click(button('Delete'))
    expect(useBotsStore.getState().dialog).toEqual({ kind: 'delete', botId: 'b1' })
    expect(fake.calls.some(([name]) => name === 'remove')).toBe(false)
  })

  it('closes', async () => {
    useBotsStore.setState({ aboutOpen: true })
    await show()
    await click(button('Close About'))
    expect(useBotsStore.getState().aboutOpen).toBe(false)
  })

  it('writes a run’s next time as a time today, or a weekday and a time', () => {
    const now = new Date(2026, 10, 7, 8, 0)
    expect(nextRunText(new Date(2026, 10, 7, 9, 0).toISOString(), now)).toMatch(/^\d{2}:\d{2}$|^\d{1,2}:\d{2}\s?[AP]M$/i)
    expect(nextRunText(new Date(2026, 10, 9, 9, 0).toISOString(), now)).toMatch(/^Mon /)
    expect(nextRunText('not a date', now)).toBe('')
  })
})
