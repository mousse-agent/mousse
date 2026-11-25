// @vitest-environment jsdom
/**
 * About this bot (bot-ui §4.8): the whole mouse beside what it does now, its model, context and cache; then sections
 * that fold (Context opens by default): Instructions, Can use and Automations, each item with a Remove that asks first;
 * Reminders, Memory, Runs on; Pause and Delete.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AT, fakeBots, installPreload, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { BotAboutPanel, nextRunText, reminderWhenText } = await import('../../src/renderer/components/bots/BotAboutPanel')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { BotDialogs } = await import('../../src/renderer/components/bots/BotDialogs')

let root: Root
let host: HTMLElement
let fake: FakeBots
const botsInitial = useBotsStore.getInitialState()
const bot = summary('b1', { name: 'Inbox helper', description: 'Tells me which emails need a reply.', look: { colour: 'green', accessory: 'scarf' } })
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent === label)
const click = async (element: Element | undefined) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => {}) }
/** A section, found by its heading as a person reads it. */
const section = (title: string) => [...host.querySelectorAll('.bot-about-fold')].find((element) => element.querySelector('.bot-about-fold-title')?.textContent === title)
/** The titles of a section's rows, without a status word beside them. */
const rows = (title: string) => [...section(title)?.querySelectorAll('.settings-item-title') ?? []].map((element) => element.firstChild?.textContent ?? '')
/** Runs on: each line's label. */
const setupRows = () => [...section('Runs on')?.querySelectorAll('.bot-about-line, .bot-about-row') ?? []].map((element) => element.querySelector('span')?.textContent)
/** Remove asks first, as everywhere in Settings: the first click only arms it. */
async function remove(label: string, confirm = 'Confirm remove') {
  const before = fake.calls.length
  await click(button(label))
  expect(fake.calls.length).toBe(before)
  await click(button(confirm))
}
const ALL_OPEN = ['context', 'prompt', 'permissions', 'automations', 'reminders', 'setup']
async function show(current = bot) {
  fake.bots = [current]
  await act(async () => root.render(createElement(BotAboutPanel, { bot: current })))
  await act(async () => {})
}

beforeEach(() => {
  // Most cases read a section's contents: every section opens, as if the owner had opened them before.
  window.localStorage.setItem('mousse-profile-default-mousse:bot-about-open', JSON.stringify(ALL_OPEN))
  fake = fakeBots({
    details: {
      b1: {
        summary: bot,
        permissions: [
          { id: 'fp1', enabled: true, title: 'use files on this computer', note: "Read and change any file or folder, except Mousse's own data.", grantedAt: '2026-11-06T10:00:00.000Z' },
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
  window.localStorage.clear()
})

describe('About this bot', () => {
  it('switches a permission off and on', async () => {
    await show()
    const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="use files on this computer"]')!
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    await click(toggle())
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    await click(toggle())
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })
  it('shows the whole mouse, the name and the prompt', async () => {
    await show()
    const head = host.querySelector('.bot-about-head')!
    const face = head.querySelector('.bot-face')!
    expect(face.getAttribute('data-view')).toBe('full')
    expect(face.getAttribute('data-colour')).toBe('green')
    expect(head.querySelector('h2')?.textContent).toBe('Inbox helper')
    expect(section('Instructions')?.querySelector('.bot-prompt-body')?.textContent).toBe('Tells me which emails need a reply.')
    // Reminders shows only when there are some.
    expect([...host.querySelectorAll('.bot-about-fold-title')].map((element) => element.textContent)).toEqual(['Context and cache', 'Instructions', 'Can use', 'Automations', 'Memory', 'Runs on'])
  })

  it('opens Context alone at first; a section opened stays open next time', async () => {
    window.localStorage.clear()
    await show()
    const opened = () => [...host.querySelectorAll('.bot-about-fold-head[aria-expanded="true"] .bot-about-fold-title')].map((element) => element.textContent)
    expect(opened()).toEqual(['Context and cache'])
    // Closed, a section still says what is inside.
    expect(section('Can use')?.querySelector('.bot-about-fold-summary')?.textContent).toBe('2 on')
    expect(section('Automations')?.querySelector('.bot-about-fold-summary')?.textContent).toBe('1 · paused')
    expect(rows('Can use')).toEqual([])
    await click(section('Can use')!.querySelector('.bot-about-fold-head')!)
    expect(rows('Can use')).toEqual(['Use files on this computer', 'Use the pdf skill'])
    act(() => root.unmount())
    root = createRoot(host)
    await show()
    expect(opened()).toEqual(['Context and cache', 'Can use'])
  })

  it('with an older service (no rows): one Model picker, by usage until the owner picks a model by hand, on this computer (#673)', async () => {
    await show()
    // One computer: no Computer row (computer names show only with two or more).
    expect(setupRows()).toEqual(['Model', 'Devices'])
    expect(host.querySelector('[data-testid="bot-about-model"]')?.textContent).toContain('By usage')
    await click(host.querySelector('[aria-label="Inbox helper\'s model"]') ?? undefined)
    const sonnet = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes('Claude · sonnet'))
    await click(sonnet)
    expect(fake.calls).toContainEqual(['setModel', 'b1', 'sonnet'])
    expect(host.querySelector('[data-testid="bot-about-model"]')?.textContent).toContain('Claude · sonnet')
  })

  describe('model rows (#673)', () => {
    const PROVIDERS = [
      { id: 'claude', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', thinkingOff: false }, { id: 'haiku', label: 'Haiku', thinkingOff: false }] },
      { id: 'pi', instanceId: 'pi:key', label: 'Anthropic API', models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'], thinkingOff: false }] }
    ]
    const EMPTY = { talk: null, light: null, medium: null, hard: null }
    let served: object = EMPTY
    const withRows = (slots: object, extra: object = {}) => {
      served = slots
      vi.mocked(fake.client.model).mockImplementation(async () => ({ model: null, slots: served, models: [], providers: PROVIDERS, computer: 'this_computer', computers: [{ id: 'this_computer', name: 'Desk' }], ...extra }) as never)
    }
    const labels = () => [...host.querySelectorAll('.bot-model-row-label')].map((element) => element.textContent)
    const picker = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label^="Inbox helper's ${label} model"]`) ?? undefined
    const saves = () => fake.calls.filter((entry) => entry[0] === 'setSlots').map((entry) => entry[2])
    /** Opens a row's picker and picks a model on an entry. */
    async function pick(label: string, model: string, entry: string) {
      await click(picker(label))
      const option = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes(model) && item.title.includes(entry))
      if (!option()) await click(document.querySelector<HTMLElement>(`[role="tab"][aria-label="${entry}"]`) ?? undefined)
      await click(option())
    }

    it('Talk and Work, each the app\'s model picker; a bot from before picks says Pick a model, and Mousse chooses until then', async () => {
      withRows(EMPTY, { named: { talk: 'sonnet', light: 'sonnet', medium: 'sonnet', hard: 'sonnet' } })
      await show()
      expect(labels()).toEqual(['Talk', 'Work'])
      expect(picker('Talk')?.getAttribute('aria-label')).toBe('Inbox helper\'s Talk model: Pick a model')
      expect(picker('Talk')?.title).toBe('Mousse runs sonnet by name, on any entry, until you pick one.')
      // One control per row: no level dropdown, nothing called Automatic.
      expect(host.querySelectorAll('.bot-model-row .ui-select')).toHaveLength(0)
      expect(host.textContent).not.toMatch(/Automatic|By usage/)
    })

    it('a row with no pick says which model it runs on: Work the same as Talk, Light and Hard the same as Medium work', async () => {
      const talk = { instanceId: 'pi:key', model: 'opus', effort: 'low' }
      withRows({ ...EMPTY, talk })
      await show()
      expect(picker('Work')?.getAttribute('aria-label')).toBe("Inbox helper's Work model: Same as Talk")
      expect(picker('Work')?.title).toBe("Runs on Opus on Anthropic API, Talk's model. Pick a model to change it.")
      // Medium work picked: Light and Hard follow it, not Talk.
      act(() => root.unmount())
      root = createRoot(host)
      withRows({ ...EMPTY, talk, medium: { instanceId: 'claude', model: 'haiku' } })
      await show()
      expect(labels()).toEqual(['Talk', 'Light work', 'Medium work', 'Hard work'])
      expect(picker('Hard work')?.getAttribute('aria-label')).toBe("Inbox helper's Hard work model: Same as Medium work")
      expect(picker('Light work')?.title).toBe("Runs on Haiku on Claude Code, Medium work's model. Pick a model to change it.")
      // Talk's entry no longer offers its model: the row says so instead of naming it.
      act(() => root.unmount())
      root = createRoot(host)
      withRows({ ...EMPTY, talk: { instanceId: 'pi:gone', model: 'opus' } })
      await show()
      expect(picker('Work')?.title).toBe("Runs on Talk's model, which is not available now. Pick a model to change it.")
    })

    it('a pick saves only its own rows, so a change the bot made meanwhile stays', async () => {
      withRows(EMPTY)
      await show()
      await pick('Work', 'Opus', 'Anthropic API')
      const onKey = { instanceId: 'pi:key', model: 'opus' }
      // Work is all three kinds of work; Talk is not sent.
      expect(saves().at(-1)).toEqual({ slots: { light: onKey, medium: onKey, hard: onKey } })
      // Meanwhile the bot moved Talk with use_model; About still shows the rows it read.
      const fromBot = { instanceId: 'claude', model: 'opus', effort: 'high' }
      served = { talk: fromBot, light: onKey, medium: onKey, hard: onKey }
      await pick('Talk', 'Haiku', 'Claude Code')
      expect(saves().at(-1)).toEqual({ slots: { talk: { instanceId: 'claude', model: 'haiku' } } })
      // Read again after the save: what the service has now.
      await act(async () => {})
      expect(picker('Work')?.getAttribute('aria-label')).toBe('Inbox helper\'s Work model: Opus · Low on Anthropic API')
    })

    it('Advanced shows each kind of work from Work\'s pick, opens by itself when they differ, and closing puts Medium work on all work', async () => {
      const sub = { instanceId: 'claude', model: 'opus' }
      withRows({ talk: sub, light: sub, medium: sub, hard: sub })
      await show()
      await click(host.querySelector('.bot-model-advanced [role="switch"]') ?? undefined)
      expect(labels()).toEqual(['Talk', 'Light work', 'Medium work', 'Hard work'])
      expect(picker('Hard work')?.getAttribute('aria-label')).toBe('Inbox helper\'s Hard work model: Opus · Medium on Claude Code')
      // Opening it saves nothing.
      expect(saves()).toEqual([])
      // What the service holds once the pick is saved, which About reads back.
      served = { talk: sub, light: sub, medium: sub, hard: { instanceId: 'claude', model: 'haiku' } }
      await pick('Hard work', 'Haiku', 'Claude Code')
      expect(saves().at(-1)).toEqual({ slots: { hard: { instanceId: 'claude', model: 'haiku' } } })
      served = { talk: sub, light: sub, medium: sub, hard: sub }
      await click(host.querySelector('.bot-model-advanced [role="switch"]') ?? undefined)
      expect(saves().at(-1)).toEqual({ oneWork: true })
      expect(labels()).toEqual(['Talk', 'Work'])
    })

    it('a row picked on a Codex not checked for bots says so once, with the versions in its tooltip, before any work is sent', async () => {
      const note = { text: 'Bots\' work won\'t run on this version of Codex: it hasn\'t been checked for bots yet.', title: 'Codex 0.999.0 is installed here. Checked for bots: 0.162.1.' }
      const onKey = { instanceId: 'pi:key', model: 'opus' }
      // The entry with the note is offered, but no row is on it: nothing to say.
      withRows({ talk: { instanceId: 'claude', model: 'opus' }, light: null, medium: null, hard: null }, { notes: { 'pi:key': note } })
      await show()
      expect(host.querySelector('[data-testid="bot-model-note"]')).toBeNull()
      // Talk and Work both on it: one line.
      served = { talk: onKey, light: onKey, medium: onKey, hard: onKey }
      await pick('Work', 'Opus', 'Anthropic API')
      await act(async () => {})
      const shown = host.querySelectorAll<HTMLElement>('[data-testid="bot-model-note"]')
      expect(shown).toHaveLength(1)
      expect(shown[0]!.textContent).toBe(note.text)
      expect(shown[0]!.title).toBe(note.title)
    })

    it('a pick not offered now says so; a refused save goes back with the service\'s words', async () => {
      withRows({ talk: { instanceId: 'pi:gone', model: 'opus' }, light: null, medium: null, hard: null })
      await show()
      expect(picker('Talk')?.getAttribute('aria-label')).toBe('Inbox helper\'s Talk model: opus · not available')
      vi.mocked(fake.client.setSlots).mockRejectedValueOnce({ code: 'model_unavailable', message: 'The model you picked is not available now. Pick another one.' })
      await pick('Work', 'Opus', 'Anthropic API')
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('The model you picked is not available now. Pick another one.')
      // Back to what it was: no pick, so it runs on Talk's model (which is not available now either).
      expect(picker('Work')?.getAttribute('aria-label')).toBe("Inbox helper's Work model: Same as Talk")
    })
  })

  it('lists the person’s other computers in Computer, greyed: a bot runs on the computer that holds it', async () => {
    vi.mocked(fake.client.model).mockImplementationOnce(async () => ({ model: null, models: [], computer: 'this_computer', computers: [{ id: 'this_computer', name: 'Desk' }, { id: 'nod_laptop', name: 'Laptop', offline: true, unavailable: 'Laptop is offline.' }] }))
    await show()
    expect(setupRows()).toEqual(['Model', 'Computer', 'Devices'])
    expect(host.querySelector('[data-testid="bot-about-computer"]')?.textContent).toContain('Desk')
    await click(host.querySelector('[aria-label="Inbox helper\'s computer"]') ?? undefined)
    const laptop = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes('Laptop · offline'))
    expect(laptop?.getAttribute('aria-disabled')).toBe('true')
  })

  it('Allow everything turns on only after its approval dialog, and off at once; an older service shows no switch', async () => {
    fake.details.b1 = { ...fake.details.b1!, fullTrust: false }
    fake.bots = [bot]
    await act(async () => root.render(createElement('div', null, createElement(BotAboutPanel, { bot }), createElement(BotDialogs))))
    await act(async () => {})
    const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Allow everything"]')!
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    await click(toggle())
    // Nothing is granted until the owner allows it in the dialog.
    expect(fake.calls.some(([name]) => name === 'setPermission')).toBe(false)
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Allow Inbox helper everything?')
    expect(dialog.textContent).toContain('Your switches, Settings and Labs still apply.')
    await click([...dialog.querySelectorAll('button')].find((element) => element.textContent === 'Allow everything'))
    expect(fake.calls).toContainEqual(['setPermission', 'b1', 'full_trust', true])
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(section('Can use')?.querySelector('.bot-about-fold-summary')?.textContent).toBe('Everything')
    await click(toggle())
    expect(fake.calls).toContainEqual(['setPermission', 'b1', 'full_trust', false])
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    // An older service sends no fullTrust: no switch.
    fake.details.b1 = { ...fake.details.b1!, fullTrust: undefined }
    useBotsStore.setState({ details: {} })
    await show()
    expect(toggle()).toBeNull()
  })

  it('lists what it can use and removes one', async () => {
    await show()
    expect(rows('Can use')).toEqual(['Use files on this computer', 'Use the pdf skill'])
    await remove('Remove use files on this computer')
    expect(fake.calls).toContainEqual(['revokePermission', 'b1', 'fp1'])
    expect(rows('Can use')).toEqual(['Use the pdf skill'])
  })

  it('what every bot has by default has a switch and no Remove, each MCP server its own', async () => {
    const grantedAt = '2026-11-06T10:00:00.000Z'
    fake.details.b1!.permissions = [
      { id: 'default:mcp', enabled: true, builtIn: true, title: 'use your MCP servers', note: 'Every MCP server set up in Mousse, in its work, without asking.', grantedAt },
      { id: 'default:mcp:srv-github', enabled: true, builtIn: true, under: 'default:mcp', title: 'use your GitHub tools', note: '2 tools: create_issue, list_issues', grantedAt },
      { id: 'default:skills', enabled: false, builtIn: true, title: 'use your skills', note: 'Every skill you have in Mousse, without asking.', grantedAt }
    ]
    await show()
    expect(rows('Can use')).toEqual(['Use your MCP servers', 'Use your GitHub tools', 'Use your skills'])
    expect([...section('Can use')!.querySelectorAll('button')].some((element) => element.getAttribute('aria-label')?.startsWith('Remove'))).toBe(false)
    const github = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="use your GitHub tools"]')!
    await click(github)
    expect(fake.calls).toContainEqual(['setPermission', 'b1', 'default:mcp:srv-github', false])
    await click(host.querySelector('[role="switch"][aria-label="use your skills"]') ?? undefined)
    expect(fake.calls).toContainEqual(['setPermission', 'b1', 'default:skills', true])
  })

  it('a permission Allow everything gives has its own switch and no Remove', async () => {
    const grantedAt = '2026-11-06T10:00:00.000Z'
    fake.details.b1 = { ...fake.details.b1!, fullTrust: true, permissions: [
      { id: 'tool:shell', enabled: true, fromFullTrust: true, title: 'run commands', note: 'Runs commands on this computer.', grantedAt },
      { id: 'tool:browser', enabled: false, fromFullTrust: true, title: 'use the browser', note: 'Switched off for this bot.', grantedAt }
    ] }
    await show()
    expect(rows('Can use')).toEqual(['Allow everything', 'Run commands', 'Use the browser'])
    expect([...section('Can use')!.querySelectorAll('button')].some((element) => element.getAttribute('aria-label')?.startsWith('Remove'))).toBe(false)
    await click(host.querySelector('[role="switch"][aria-label="run commands"]') ?? undefined)
    expect(fake.calls).toContainEqual(['setPermission', 'b1', 'tool:shell', false])
  })

  it('marks an MCP server that gives nothing now with what is true of it, keeping Remove', async () => {
    fake.details.b1!.permissions = [
      { id: 'fp3', title: 'use your GitHub tools', note: 'GitHub is switched off in Settings → Skills & MCP, so this gives nothing while it is. Switch it on there to use it again, or remove it.', grantedAt: '2026-11-06T10:00:00.000Z', mark: 'Switched off' },
      // An older service sends `gone` only.
      { id: 'fp4', title: 'use your Notes tools', note: 'Notes isn\'t set up in Mousse any more.', grantedAt: '2026-11-06T10:00:00.000Z', gone: true }
    ]
    await show()
    expect([...section('Can use')!.querySelectorAll('.bot-about-status')].map((element) => element.textContent)).toEqual(['Switched off', 'Gone from Mousse'])
    expect(button('Remove use your GitHub tools')).toBeDefined()
  })

  it('says what its chat turns cost over the last week once turns reported usage, and nothing before', async () => {
    await show()
    expect(host.querySelector('[data-testid="bot-about-usage"]')).toBeNull()
    fake.details.b1 = { ...fake.details.b1, usage: { turns: 12, inputPerTurn: 18_400, outputPerTurn: 640, cachedShare: 0.72 } }
    await act(async () => { await useBotsStore.getState().loadDetail('b1') })
    const line = host.querySelector<HTMLElement>('[data-testid="bot-about-usage"]')!
    expect(line.textContent).toContain('12 turns · 18k in, 640 out a turn')
    expect(line.textContent).toContain('72% cached')
    expect(line.querySelector<HTMLElement>('[title]')?.title).toContain('Chat turns in the last 7 days: 12')
  })

  describe('context and cache, from its latest chat turn', () => {
    const MIN = 60_000
    const measured = (extra: object = {}) => ({ used: 76_000, window: 200_000, model: 'claude-opus-5-5', turn: { cacheRead: 69_000, cacheWrite: 4_000, fresh: 3_000 }, lastRequestAt: Date.now() - 2 * MIN - 1000, cacheTtlMs: 5 * MIN, ...extra })
    const fact = (term: string) => [...host.querySelectorAll('.bot-about-facts dt')].find((element) => element.textContent === term)?.nextElementSibling?.textContent

    it('before any turn: no figures, and Context says when it will know', async () => {
      await show()
      expect(fact('Context')).toBeUndefined()
      expect(fact('Cache')).toBeUndefined()
      expect(section('Context and cache')?.textContent).toContain('Measured after its next message.')
    })

    it("how full its context is, how the last turn's input split, and how long the cache stays warm", async () => {
      fake.details.b1 = { ...fake.details.b1!, context: measured() }
      await show()
      expect(fact('Context')).toBe('38% of 200k used')
      // No Talk pick read yet: the model that answered, by name.
      expect(fact('Model')).toBe('Opus 5.5')
      expect(fact('Cache')).toBe('Warm, 3m left')
      const context = host.querySelector('[data-testid="bot-about-context"]')!
      expect(context.textContent).toContain('76k of 200k tokens')
      expect(context.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Context 38% full')
      expect([...context.querySelectorAll('.context-usage-item')].map((item) => item.textContent)).toEqual(['Read from cache91%', 'Written to cache5%', 'Sent fresh4%'])
      expect(section('Context and cache')?.textContent).toContain('Next message reads 76k from cache.')
    })

    it('an expired cache says the next message sends it all again; without a lifetime, how long it has been idle', async () => {
      fake.details.b1 = { ...fake.details.b1!, context: measured({ lastRequestAt: Date.now() - 65 * MIN }) }
      await show()
      expect(fact('Cache')).toBe('Expired 1h ago')
      expect(section('Context and cache')?.textContent).toContain('Next message sends all 76k again.')
      act(() => root.unmount())
      root = createRoot(host)
      fake.details.b1 = { ...fake.details.b1!, context: measured({ cacheTtlMs: undefined, lastRequestAt: Date.now() - 10 * MIN }) }
      await show()
      expect(fact('Cache')).toBe('Idle 10m')
    })

    it('a runtime that reports no token count or window shows the cache alone', async () => {
      fake.details.b1 = { ...fake.details.b1!, context: measured({ used: undefined, window: undefined }) }
      await show()
      expect(fact('Context')).toBeUndefined()
      expect(fact('Cache')).toBe('Warm, 3m left')
      expect(section('Context and cache')?.textContent).toContain('Next message reads from cache.')
    })
  })

  it('lists each automation by name, when it runs, what it does and how its last run went; removes one after asking', async () => {
    const next = new Date(Date.now() + 26 * 60 * 60_000).toISOString()
    fake.details.b1!.runs = [
      { id: 's1', label: 'every weekday · 09:00', kind: 'schedule', nextAt: next, name: 'Morning PR digest', does: 'Read open PRs and tell me which need me.', lastAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), lastOutcome: 'failed' },
      // An older service sends the schedule alone: it is named by when it runs.
      { id: 's2', label: 'every Friday · 16:00', kind: 'schedule', paused: true }
    ]
    await show()
    expect(rows('Automations')).toEqual(['Morning PR digest', 'Every Friday at 16:00'])
    const automations = () => [...section('Automations')!.querySelectorAll('.bot-about-automation')]
    expect(automations()[0]!.textContent).toContain(`Every weekday at 09:00 · next ${nextRunText(next)}`)
    expect(automations()[0]!.textContent).toContain('Read open PRs and tell me which need me.')
    expect(automations()[0]!.textContent).toContain('Last ran 3h ago, failed')
    expect(automations()[1]!.textContent).toContain('Paused')
    await remove('Remove Morning PR digest')
    expect(fake.calls).toContainEqual(['removeSchedule', 'b1', 's1'])
    expect(rows('Automations')).toEqual(['Every Friday at 16:00'])
  })

  it('removes its last automation and says how to get one', async () => {
    await show()
    await remove('Remove every weekday · 09:00')
    expect(fake.calls).toContainEqual(['removeSchedule', 'b1', 's1'])
    expect(rows('Automations')).toEqual([])
    expect(host.textContent).toContain('Only when you message it. Ask it to run on a schedule.')
  })

  it('lists its waiting reminders with when each fires, and cancels one after asking', async () => {
    const at = new Date(Date.now() + 2 * 60 * 60_000).toISOString()
    fake.details.b1 = { summary: bot, permissions: [], runs: [], reminders: [
      { id: 'rem_1', dueAt: at, text: 'Call mum.' },
      { id: 'rem_2', dueAt: at, text: 'Check the weather.', work: true },
      // Wakes, the bot's own follow-ups: at a time, and on an event (its time is then when it gives up, on hover).
      { id: 'rem_3', dueAt: at, text: 'Look at the logs again.', wake: '' },
      { id: 'rem_4', dueAt: at, text: 'Tell them it shipped.', wake: 'when acme/app#12 merges' }
    ] }
    await show()
    const reminders = () => [...section('Reminders')!.querySelectorAll('.settings-item')]
    expect(reminders().map((row) => row.querySelector('.bot-about-clamp')!.textContent)).toEqual(['Call mum.', 'Check the weather.', 'Look at the logs again.', 'Tell them it shipped.'])
    expect(reminders().map((row) => row.querySelector('.settings-item-desc')!.textContent)).toEqual([
      `Reminds: ${reminderWhenText(at)}`,
      `Starts: ${reminderWhenText(at)}`,
      `Follows up: ${reminderWhenText(at)}`,
      'Follows up when acme/app#12 merges'
    ])
    expect(reminders()[3]!.querySelector('.settings-item-desc [title]')!.getAttribute('title')).toBe(`Gives up: ${reminderWhenText(at)}`)
    await remove('Cancel reminder: Call mum.', 'Confirm cancel')
    expect(fake.calls).toContainEqual(['cancelReminder', 'b1', 'rem_1'])
    expect(reminders().map((row) => row.querySelector('.bot-about-clamp')!.textContent)).toEqual(['Check the weather.', 'Look at the logs again.', 'Tell them it shipped.'])
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
      'Only when you message it. Ask it to run on a schedule.'
    ])
  })

  it('shows its memory as one row with the count and the split, which opens Memory', async () => {
    const entry = (id: string, kind: 'owner' | 'note' | 'run_note', status: 'active' | 'expired' = 'active') => ({ id, version: 1, ref: id, kind, text: `Entry ${id}.`, since: AT, learnedAt: AT, by: 'you said' as const, status })
    fake.memory.b1 = [entry('m1', 'owner'), entry('m2', 'note'), entry('m3', 'run_note'), entry('m4', 'owner', 'expired'), entry('m5', 'note')]
    await show()
    // Only what every turn carries is counted: the expired entry is not.
    const row = host.querySelector<HTMLButtonElement>('[data-testid="bot-about-memory"]')!
    expect(row.textContent).toBe('Memory1 wish · 3 notes')
    expect(host.querySelectorAll('[data-testid="bot-about-memory"]')).toHaveLength(1)
    await click(row)
    expect(useBotsStore.getState().memoryOpen).toEqual({ botId: 'b1' })
  })

  it('counts its memory again when the bot changes, so an entry it just saved is counted', async () => {
    await show()
    const row = () => host.querySelector('[data-testid="bot-about-memory"]')!.textContent
    expect(row()).toBe('MemoryNothing yet')
    fake.memory.b1 = [{ id: 'm1', version: 1, ref: 'm1', kind: 'owner', text: 'Call the owner Sam.', since: AT, learnedAt: AT, by: 'you said', status: 'active' }]
    // A detail read over the bridge is a new object each time.
    fake.details.b1 = { ...fake.details.b1! }
    await act(async () => { await useBotsStore.getState().loadDetail('b1') })
    await act(async () => {})
    expect(row()).toBe('Memory1 wish')
  })

  it('pauses, resumes and asks before deleting', async () => {
    await show()
    await click(button('Pause'))
    expect(fake.calls).toContainEqual(['pause', 'b1'])
    await show({ ...bot, state: 'paused', stateText: 'Paused' })
    await click(button('Resume'))
    expect(fake.calls).toContainEqual(['resume', 'b1'])
    await click(button('Delete bot'))
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

describe("the bot's prompt in About", () => {
  /** About as the chat mounts it: the bot as the store holds it now, so a save shows. */
  const Host = () => {
    const current = useBotsStore((s) => s.bots.find((entry) => entry.id === 'b1'))
    return current ? createElement(BotAboutPanel, { bot: current }) : null
  }
  async function mount(current = bot) {
    fake.bots = [current]
    fake.details.b1 = { ...fake.details.b1!, summary: current }
    useBotsStore.setState({ bots: [current] })
    await act(async () => root.render(createElement(Host)))
    await act(async () => {})
  }
  const field = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Inbox helper\'s prompt"]')
  const body = () => host.querySelector('.bot-prompt-body')?.textContent
  const edit = () => click(button("Edit Inbox helper's prompt"))
  const type = async (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(field(), value)
      field()!.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const updates = () => vi.mocked(fake.client.update).mock.calls

  it('keeps its line breaks, and Edit then Save sends the new words and shows them', async () => {
    await mount({ ...bot, description: 'Check my mail.\n\nKeep it short.' })
    expect(body()).toBe('Check my mail.\n\nKeep it short.')
    await edit()
    expect(field()!.value).toBe('Check my mail.\n\nKeep it short.')
    // Nothing changed yet: nothing to save.
    expect(button('Save')!.disabled).toBe(true)
    await type('Answer in one line.')
    await click(button('Save'))
    expect(updates()).toEqual([['b1', { description: 'Answer in one line.' }]])
    expect(field()).toBeNull()
    expect(body()).toBe('Answer in one line.')
  })

  it('Cancel and Escape leave the words as they were, and save nothing', async () => {
    await mount()
    await edit()
    await type('Something else.')
    await click(button('Cancel'))
    expect(field()).toBeNull()
    expect(body()).toBe('Tells me which emails need a reply.')
    await edit()
    expect(field()!.value).toBe('Tells me which emails need a reply.')
    await type('Something else.')
    await act(async () => { field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(field()).toBeNull()
    expect(body()).toBe('Tells me which emails need a reply.')
    expect(updates()).toEqual([])
  })

  it('offers Reset to default once the owner edited it, and it puts the earlier words back', async () => {
    await mount()
    await edit()
    expect(button('Reset to default')!.disabled).toBe(true)
    await click(button('Cancel'))

    await mount({ ...bot, description: 'My own words.', promptEdited: true })
    expect(host.querySelector('.bot-prompt-mark')?.textContent).toBe('Edited')
    vi.mocked(fake.client.update).mockImplementationOnce(async () => ({ ...bot }))
    await edit()
    await click(button('Reset to default'))
    expect(updates()).toEqual([['b1', { description: null }]])
    expect(field()).toBeNull()
    expect(body()).toBe('Tells me which emails need a reply.')
    expect(host.querySelector('.bot-prompt-mark')).toBeNull()
  })

  it('keeps the editor open with why when a save fails', async () => {
    await mount()
    vi.mocked(fake.client.update).mockRejectedValueOnce(Object.assign(new Error('Say what the bot should do in 1 to 500 characters'), { code: 'invalid_params' }))
    await edit()
    await type('New words.')
    await click(button('Save'))
    expect(host.querySelector('.bot-prompt-error')?.textContent).toContain('1 to 500 characters')
    expect(field()!.value).toBe('New words.')
    expect(body()).toBeUndefined()
  })
})

it.each([true, false])('keeps whole-service controls with asks-first projection %s', async (asking) => {
  fake.details.b1.permissions = [{ id: 'mail', title: 'use Mail', enabled: true, grantedAt: AT, note: asking ? 'Asks you first before sending or changing something. What it does through threads, commands or secrets you gave it does not wait for a card.' : 'Use the connected Mail service.', ...(asking ? { mark: 'Asks first' } : {}) }]
  await show()
  expect(host.textContent?.includes('Asks first')).toBe(asking)
  const title = [...host.querySelectorAll('span')].find((item) => item.title.includes(asking ? 'Asks you first before sending' : 'connected Mail'))
  expect(title).toBeTruthy()
  const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="use Mail"]')!
  await click(toggle())
  expect(fake.calls).toContainEqual(['setPermission', 'b1', 'mail', false])
  await click(toggle())
  expect(fake.calls).toContainEqual(['setPermission', 'b1', 'mail', true])
  await remove('Remove use Mail')
  expect(fake.calls).toContainEqual(['revokePermission', 'b1', 'mail'])
  expect(toggle()).toBeNull()
})

it('keeps chat usage and the service asks-first row together with whole-service controls', async () => {
  fake.details.b1 = { ...fake.details.b1, usage: { turns: 12, inputPerTurn: 18_400, outputPerTurn: 640, cachedShare: 0.72 }, permissions: [{
    id: 'mail', title: 'use your Mail tools', note: 'Asks you first before sending or changing something. What it does through threads, commands or secrets you gave it does not wait for a card.', enabled: true, mark: 'Asks first', asksFirst: true, grantedAt: AT
  }] }
  await show()
  const usage = () => host.querySelector<HTMLElement>('[data-testid="bot-about-usage"]')!
  const service = () => [...host.querySelectorAll('.bot-about-permission')].find(element => element.textContent?.includes('Use your Mail tools'))!
  expect(usage().textContent).toContain('72% cached')
  expect(service().textContent).toContain('Asks first')
  expect(service().contains(usage())).toBe(false)
  const toggle = service().querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(toggle.getAttribute('aria-label')).toBe('use your Mail tools')
  await click(toggle)
  expect(fake.calls).toContainEqual(['setPermission', 'b1', 'mail', false])
  expect(usage().textContent).toContain('72% cached')
  await remove('Remove use your Mail tools')
  expect(fake.calls).toContainEqual(['revokePermission', 'b1', 'mail'])
  expect(service()).toBeUndefined()
  expect(usage().textContent).toContain('18k in')
})

it('shows the asks-first coverage as visible permission text', async () => {
  const coverage = 'Only the bot’s own tool calls wait. Calls through threads, commands or secrets do not.'
  fake.details.b1.permissions = [{ id: 'mail', title: 'use your Trial mail tools', enabled: true, grantedAt: AT, note: coverage, mark: 'Asks first', asksFirst: true }]
  await show()
  const permission = button('Remove use your Trial mail tools')!.closest('.bot-about-permission')!
  expect(permission.textContent).toContain('Asks first')
  expect(permission.textContent).toContain(coverage)
})
