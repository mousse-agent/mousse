// @vitest-environment jsdom
/**
 * New bot (bot-ui §4.2) in three steps, as Add provider shows them: Look (already picked, one the owner's other bots
 * don't wear, Shuffle), What it does (an optional name and one sentence, which Next waits for) and Runs on, where
 * Create bot opens the chat. An older service has no Runs on step. Create bot always answers (busy, then the bot or a
 * plain error on the step that can fix it), and nothing that moves between steps, closes, remounts or hides the
 * dialog loses what the owner put in.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, message, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/chats/ChatResourcesPanel', () => ({ ChatResourcesPanel: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTranscript', () => ({ NetworkTranscript: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkChatActions', () => ({ NetworkChatActions: () => null }))
vi.mock('../../src/renderer/components/chats/NetworkTaskPicker', () => ({ NetworkTaskPicker: () => null }))
vi.mock('../../src/renderer/components/chats/ChatBrowserAccess', () => ({ ChatBrowserAccess: () => null }))
vi.mock('../../src/renderer/components/ComposerQuestionModal', () => ({ ComposerQuestionModal: () => null }))
// The composer's microphone pulls in audio worklets jsdom does not have; these tests never record.
vi.mock('../../src/renderer/dictation/microphone', () => ({}))
vi.mock('../../src/renderer/components/editors/MarkdownPreview', async () => {
  const { createElement: h } = await import('react')
  return { MarkdownPreview: ({ value, className }: { value: string; className?: string }) => h('div', { className }, value) }
})

const { ChatWorkspace } = await import('../../src/renderer/components/chats/ChatWorkspace')
// App mounts New bot apart from the chat pane; Automations mounts the dialog itself.
const { NewBotDialog, NewBotDialogHost } = await import('../../src/renderer/components/bots/NewBotDialog')
const { useChatsStore } = await import('../../src/renderer/stores/chatsStore')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')

let root: Root
let host: HTMLElement
let fake: FakeBots
const chatsInitial = useChatsStore.getInitialState()
const botsInitial = useBotsStore.getInitialState()

const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')
// The look picker's two radio groups (WP5's `BotLookPicker`).
const GROUPS = { 'bot-look-colour': '.bot-look-picker__colours', 'bot-look-accessory': '.bot-look-picker__accessories' } as const
const picked = (group: keyof typeof GROUPS) => dialog()?.querySelector(`${GROUPS[group]} [aria-checked="true"]`)?.getAttribute('aria-label')
const buttonNamed = (label: string) => [...(dialog()?.querySelectorAll('button') ?? [])].find((element) => element.textContent === label) as HTMLButtonElement | undefined
const createButton = () => buttonNamed('Create bot')
const nextButton = () => buttonNamed('Next')
const backButton = () => buttonNamed('Back')
/** The step shown: look, about or runsOn. */
const stepNow = () => dialog()?.querySelector<HTMLElement>('.bot-new-step')?.dataset.step
const stepLabels = () => [...(dialog()?.querySelectorAll('.wizard-step-label') ?? [])].map((element) => element.textContent)
const stepTab = (label: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('.wizard-step')].find((element) => element.querySelector('.wizard-step-label')?.textContent?.startsWith(label))!
const click = async (element: HTMLElement | undefined) => { await act(async () => element!.click()) }
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
const keyDown = async (element: HTMLElement, init: KeyboardEventInit) => { await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) }) }
/** Enter in a single-line field submits the form (jsdom does not do that implicit submission itself). */
const pressEnterIn = async (element: HTMLInputElement) => { await act(async () => { element.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }) }
/** The Chats pane (when `pane`) and App's New bot. */
async function render(pane = true) {
  await act(async () => root.render(createElement('div', null, pane && createElement(ChatWorkspace), createElement(NewBotDialogHost))))
}
async function open(existing = fake.bots) {
  fake.bots = existing
  await act(async () => useChatsStore.getState().activate('p1'))
  await render()
  await act(async () => useBotsStore.setState({ newBotOpen: true }))
}
/** A promise settled by hand: a create (or list) still on its way. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const nameBox = () => dialog()!.querySelector<HTMLInputElement>('#bot-new-name')!
const textBox = () => dialog()!.querySelector<HTMLTextAreaElement>('#bot-new-text')!
const modelPicker = () => dialog()!.querySelector<HTMLElement>('[aria-label="New bot\'s model"]')!
const pickOption = async (label: string) => click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === label))
const creates = () => fake.calls.filter(([name]) => name === 'create') as Array<[string, Record<string, unknown>]>
/** From Look to What it does, then (with a sentence) to Runs on. */
async function toAbout() { if (stepNow() === 'look') await click(nextButton()) }
async function toRunsOn(text?: string) {
  await toAbout()
  if (text) await type(textBox(), text)
  await click(nextButton())
}
/** Purple with a crown, Garden, and a sentence: everything the owner can put in, on the first two steps. */
async function fillIn() {
  await click(dialog()!.querySelector<HTMLElement>('[aria-label="Purple"]')!)
  await click(dialog()!.querySelector<HTMLElement>('[aria-label="Crown"]')!)
  await click(nextButton())
  await type(nameBox(), 'Garden')
  await type(textBox(), 'Remind me to water the plants.')
}
/** What the first two steps show, read by going back to Look through the step bar and on again. */
async function filledIn() {
  await click(stepTab('Look'))
  const look = { colour: picked('bot-look-colour'), accessory: picked('bot-look-accessory') }
  await click(nextButton())
  return { name: nameBox()?.value, text: textBox()?.value, ...look }
}
const FILLED = { name: 'Garden', text: 'Remind me to water the plants.', colour: 'Purple', accessory: 'Crown' }
const backdrop = () => host.querySelector<HTMLElement>('.chat-dialog-backdrop')!
const mouseDown = async (element: HTMLElement) => { await act(async () => { element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) }) }

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
  useChatsStore.setState(chatsInitial)
  useBotsStore.setState(botsInitial)
})

describe('New bot', () => {
  it('is three steps: a look, what it does and where it runs, and nothing about permissions', async () => {
    await open([])
    const box = dialog()!
    expect(box.querySelector('h2')?.textContent).toBe('New bot')
    expect(stepLabels()).toEqual(['Look', 'What it does', 'Runs on'])
    // Look: already picked, with the face large; Next works at once and there is nothing to go back to.
    expect(stepNow()).toBe('look')
    expect([...box.querySelectorAll('.bot-look-picker__colours [role="radio"]')]).toHaveLength(8)
    expect([...box.querySelectorAll('.bot-look-picker__accessories [role="radio"]')]).toHaveLength(12)
    expect(box.querySelector('.bot-look-picker__preview .bot-face')?.getAttribute('width')).toBe('150')
    expect(nextButton()?.disabled).toBe(false)
    expect(backButton()).toBeUndefined()
    expect(box.textContent).not.toMatch(/sonnet|permission|schedule|device/i)
    // What it does: an optional name and one sentence.
    await click(nextButton())
    expect(stepNow()).toBe('about')
    expect(nameBox().placeholder).toBe('Optional. Leave it empty and the bot names itself.')
    expect(textBox().placeholder).toBe('For example: every morning, tell me which emails need a reply.')
    expect([...box.querySelectorAll('input, textarea, select')]).toHaveLength(2)
    expect(box.textContent).not.toMatch(/sonnet|permission|schedule|device/i)
    // Runs on: this computer, by usage, as About → Runs on says it. No model is named until one is picked.
    await toRunsOn('Remind me to water the plants.')
    expect(stepNow()).toBe('runsOn')
    expect(box.querySelector('[data-testid="bot-new-runs-on"]')?.textContent).toBe('ComputerDeskModelBy usage')
    expect(createButton()?.disabled).toBe(false)
    expect(nextButton()).toBeUndefined()
    expect(box.textContent).not.toMatch(/sonnet|permission|schedule|device/i)
  })

  it('lands focus on each step’s first control', async () => {
    await open([])
    expect(document.activeElement?.textContent?.trim()).toBe('Shuffle')
    await click(nextButton())
    expect(document.activeElement).toBe(nameBox())
    await toRunsOn('Remind me to water the plants.')
    expect(document.activeElement).toBe(modelPicker())
  })

  it('with a service from before rows: one Model picker, by usage when left alone, or a model picked by hand (#673)', async () => {
    await open([])
    await toRunsOn('Remind me to water the plants.')
    await click(modelPicker())
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(['By usage', 'Claude · sonnet'])
    await pickOption('Claude · sonnet')
    expect(dialog()!.querySelector('[data-testid="bot-new-runs-on"]')?.textContent).toContain('Claude · sonnet')
    // Picking By usage again clears it.
    await click(modelPicker())
    await pickOption('By usage')
    expect(useBotsStore.getState().newBotDraft.model).toBeNull()
    await click(modelPicker())
    await pickOption('Claude · sonnet')
    await click(createButton())
    await act(async () => {})
    expect(creates()[0]![1]).toMatchObject({ description: 'Remind me to water the plants.', model: 'sonnet' })
    expect(dialog()).toBeNull()
  })

  it('sends no model when Runs on is left alone', async () => {
    await open([])
    await toRunsOn('Remind me to water the plants.')
    await click(createButton())
    await act(async () => {})
    expect(creates()[0]![1]).not.toHaveProperty('model')
  })

  it('says so on Runs on when the picked model is gone by Create bot, and shows it as not available now', async () => {
    await open([])
    await toRunsOn('Remind me to water the plants.')
    await click(modelPicker())
    await pickOption('Claude · sonnet')
    vi.mocked(fake.client.create).mockRejectedValueOnce(Object.assign(new Error('The model you picked is not available now. Pick another one, or By usage.'), { code: 'model_unavailable' }))
    vi.mocked(fake.client.modelChoices).mockImplementationOnce(async () => ({ models: [], computer: 'this_computer', computers: [{ id: 'this_computer', name: 'Desk' }] }))
    await click(createButton())
    await act(async () => {})
    expect(stepNow()).toBe('runsOn')
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('The model you picked is not available now. Pick another one, or By usage.')
    expect(dialog()?.querySelector('[data-testid="bot-new-runs-on"]')?.textContent).toContain('sonnet (not available now)')
    expect(useChatsStore.getState().activeBotId).toBeNull()
  })

  it('goes back to What it does with the service’s own words when it refuses the sentence', async () => {
    await open([])
    await toRunsOn('Watch for cheap flights.')
    vi.mocked(fake.client.create).mockRejectedValueOnce({ code: 'invalid_params', message: 'Say what the bot should do in 1 to 500 characters.' })
    await click(createButton())
    await act(async () => {})
    expect(stepNow()).toBe('about')
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Say what the bot should do in 1 to 500 characters.')
    expect(textBox().value).toBe('Watch for cheap flights.')
    // Moving on clears it; it was the sentence's.
    await click(nextButton())
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull()
  })

  it('has two steps with an older service, Create bot on What it does, and creates by usage as before', async () => {
    vi.mocked(fake.client.modelChoices).mockRejectedValue(Object.assign(new Error('Unknown method'), { code: 'method_not_found' }))
    await open([])
    expect(stepLabels()).toEqual(['Look', 'What it does'])
    await click(nextButton())
    expect(stepNow()).toBe('about')
    expect(nextButton()).toBeUndefined()
    expect(dialog()!.querySelector('[data-testid="bot-new-runs-on"]')).toBeNull()
    expect(createButton()?.disabled).toBe(true)
    await type(textBox(), 'Remind me to water the plants.')
    // Cmd/Ctrl+Enter in the sentence is Create bot here.
    await keyDown(textBox(), { key: 'Enter', metaKey: true })
    await act(async () => {})
    expect(creates()).toHaveLength(1)
    expect(creates()[0]![1]).not.toHaveProperty('model')
  })

  it('lists the person’s other computers greyed, as About does', async () => {
    vi.mocked(fake.client.modelChoices).mockImplementation(async () => ({ models: [], computer: 'this_computer', computers: [{ id: 'this_computer', name: 'Desk' }, { id: 'nod_laptop', name: 'Laptop', unavailable: 'A bot runs on the computer that holds it.' }] }))
    await open([])
    await toRunsOn('Remind me to water the plants.')
    await click(dialog()!.querySelector<HTMLElement>('[aria-label="New bot\'s computer"]')!)
    const laptop = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes('Laptop'))
    expect(laptop?.getAttribute('aria-disabled')).toBe('true')
    expect(laptop?.textContent).toContain('A bot runs on the computer that holds it.')
  })

  it('starts with a look the other bots don’t wear', async () => {
    await open([summary('a', { look: { colour: 'coral', accessory: 'none' } }), summary('b', { look: { colour: 'teal', accessory: 'headphones' } })])
    expect(picked('bot-look-accessory')).not.toMatch(/^(None|Headphones)$/)
    expect(picked('bot-look-colour')).toBeTruthy()
  })

  it('changes the look by colour, accessory and Shuffle', async () => {
    await open([])
    const box = dialog()!
    await click(box.querySelector<HTMLElement>('[aria-label="Purple"]')!)
    await click(box.querySelector<HTMLElement>('[aria-label="Crown"]')!)
    expect([picked('bot-look-colour'), picked('bot-look-accessory')]).toEqual(['Purple', 'Crown'])
    expect(box.querySelector('.bot-look-picker__preview .bot-face')?.getAttribute('data-colour')).toBe('purple')
    await click([...box.querySelectorAll<HTMLElement>('button')].find((element) => element.textContent?.trim() === 'Shuffle'))
    expect([picked('bot-look-colour'), picked('bot-look-accessory')]).not.toEqual(['Purple', 'Crown'])
  })

  it('moves past What it does only with a sentence, then Create bot opens the chat with its first message', async () => {
    await open([])
    await click(nextButton())
    expect(nextButton()?.disabled).toBe(true)
    await type(textBox(), '   ')
    expect(nextButton()?.disabled).toBe(true)
    // Enter in the name with no sentence yet goes to the sentence, not on.
    await pressEnterIn(nameBox())
    expect(stepNow()).toBe('about')
    expect(document.activeElement).toBe(textBox())
    expect(stepTab('Runs on').disabled).toBe(true)
    await type(textBox(), 'Every morning, tell me which emails need a reply.')
    expect(nextButton()?.disabled).toBe(false)
    await click(nextButton())
    await click(createButton())
    await act(async () => {})
    const [, input] = creates()[0]!
    expect(input).toMatchObject({ description: 'Every morning, tell me which emails need a reply.' })
    expect(input).not.toHaveProperty('name')
    expect(typeof input.clientRequestId).toBe('string')
    expect(input.look).toEqual(expect.objectContaining({ colour: expect.any(String), accessory: expect.any(String) }))
    expect(dialog()).toBeNull()
    expect(useChatsStore.getState().activeBotId).toBe('new1')
    expect(host.querySelector('.chat-conversation-header h1')?.textContent).toBe('Inbox helper')
    expect(host.querySelector('.chat-run-status')?.textContent).toBe('Inbox helper is working…')
    await act(async () => fake.emit.message('new1', message(1, { text: 'Hi, I’m Inbox helper.' })))
    expect(host.querySelector('.chat-transcript')?.textContent).toContain('Hi, I’m Inbox helper.')
  })

  it('moves on with Enter in the name and Cmd/Ctrl+Enter in the sentence', async () => {
    await open([])
    await click(nextButton())
    await type(textBox(), 'Remind me to water the plants.')
    await pressEnterIn(nameBox())
    expect(stepNow()).toBe('runsOn')
    await click(backButton())
    await keyDown(textBox(), { key: 'Enter', ctrlKey: true })
    expect(stepNow()).toBe('runsOn')
    // A plain Enter in the sentence is a new line, not a step.
    await click(backButton())
    await keyDown(textBox(), { key: 'Enter' })
    expect(stepNow()).toBe('about')
    expect(creates()).toHaveLength(0)
  })

  it('sends the name when one is given', async () => {
    await open([])
    await click(nextButton())
    await type(nameBox(), '  Garden  ')
    await toRunsOn('Remind me to water the plants.')
    await click(createButton())
    await act(async () => {})
    expect(creates()[0]?.[1]).toMatchObject({ name: 'Garden' })
  })

  it('opens from Automations on What it does with the automation’s words, and hands the bot back', async () => {
    const onCreated = vi.fn()
    await act(async () => useChatsStore.getState().activate('p1'))
    await act(async () => root.render(createElement(NewBotDialog, { initialDescription: 'Every Friday, sum up my week.', onCreated })))
    expect(stepNow()).toBe('about')
    expect(textBox().value).toBe('Every Friday, sum up my week.')
    expect(document.activeElement).toBe(nameBox())
    await click(nextButton())
    await click(createButton())
    await act(async () => {})
    expect(creates()[0]![1]).toMatchObject({ description: 'Every Friday, sum up my week.' })
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'new1' }))
    // Automations picks the bot; its chat does not open.
    expect(useChatsStore.getState().activeBotId).toBeNull()
  })
})

describe('Create bot always answers', () => {
  it('shows Creating… while the create is on its way, and a second click or Ctrl+Enter makes no second request', async () => {
    await open([])
    const pending = deferred<ReturnType<typeof summary>>()
    vi.mocked(fake.client.create).mockImplementationOnce((input) => { fake.calls.push(['create', input]); return pending.promise })
    await toRunsOn('Watch for cheap flights.')
    await act(async () => { createButton()!.click(); createButton()!.click() })
    await keyDown(dialog()!.querySelector('form')!, { key: 'Enter', ctrlKey: true })
    const busy = [...dialog()!.querySelectorAll('button')].find((element) => element.textContent?.includes('Creating…')) as HTMLButtonElement
    expect(busy?.disabled).toBe(true)
    expect(backButton()?.disabled).toBe(true)
    expect(creates()).toHaveLength(1)
    await act(async () => pending.resolve(summary('new1', { name: 'Flight deals' })))
    await act(async () => {})
    expect(dialog()).toBeNull()
    expect(useChatsStore.getState().activeBotId).toBe('new1')
  })

  it('says in plain words when the create fails, keeps everything put in, and a retry reuses the request', async () => {
    await open([])
    await fillIn()
    await click(nextButton())
    vi.mocked(fake.client.create).mockRejectedValueOnce({ code: 'platform_request_failed', message: 'Something went wrong. Please try again or report this error. Reference: 1234' })
    await click(createButton())
    await act(async () => {})
    // No step can fix this one: it stays where Create bot was pressed.
    expect(stepNow()).toBe('runsOn')
    const alert = dialog()?.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toBe('Mousse couldn’t finish making the bot. What you wrote is kept: press Create bot to try again. It won’t make the same bot twice.')
    expect(alert).not.toMatch(/Reference|Something went wrong/)
    expect(useChatsStore.getState().activeBotId).toBeNull()
    expect(await filledIn()).toEqual(FILLED)
    await click(nextButton())
    expect(createButton()?.disabled).toBe(false)
    await click(createButton())
    await act(async () => {})
    const [[first], [second]] = vi.mocked(fake.client.create).mock.calls
    expect(second!.clientRequestId).toBe(first!.clientRequestId)
    expect(useChatsStore.getState().activeBotId).toBe('new1')
  })

  it('keeps the new bot open when a list asked for before it was made arrives after it', async () => {
    await open([summary('a', { name: 'Inbox helper' })])
    const stale = deferred<ReturnType<typeof summary>[]>()
    vi.mocked(fake.client.list).mockImplementationOnce(() => stale.promise)
    await toRunsOn('Every morning, tell me which emails need a reply.')
    // The 2-second poll is on its way when Create bot is pressed.
    void useBotsStore.getState().refresh()
    await click(createButton())
    await act(async () => {})
    await act(async () => stale.resolve([summary('a', { name: 'Inbox helper' })]))
    await act(async () => {})
    expect(useChatsStore.getState().activeBotId).toBe('new2')
    expect(host.querySelector('.chat-conversation-header h1')?.textContent).toBe('Inbox helper')
    expect(useBotsStore.getState().bots.map((bot) => bot.id)).toEqual(['a', 'new2'])
  })
})

describe('New bot keeps what was put in', () => {
  it('moving back and forth between the steps', async () => {
    await open([])
    await fillIn()
    await click(nextButton())
    await click(backButton())
    await click(backButton())
    expect(stepNow()).toBe('look')
    expect([picked('bot-look-colour'), picked('bot-look-accessory')]).toEqual(['Purple', 'Crown'])
    await click(nextButton())
    expect([nameBox().value, textBox().value]).toEqual(['Garden', 'Remind me to water the plants.'])
  })

  it('through polls, a bot opening behind it and the chat pane going away', async () => {
    fake.chats.a = [message(1)]
    await open([summary('a', { name: 'Inbox helper' })])
    await fillIn()
    fake.bots = [summary('a', { name: 'Inbox helper', state: 'working', stateText: 'Working…' }), summary('b', { name: 'Garden helper' })]
    await act(async () => { fake.emit.changed('a'); await useBotsStore.getState().refresh() })
    expect(await filledIn()).toEqual(FILLED)
    // A bot's chat opens behind it (a notification, a bot's own event).
    await act(async () => useChatsStore.setState({ activeBotId: 'a' }))
    expect(await filledIn()).toEqual(FILLED)
    // The pane switches to Projects (a thread is selected) and back.
    await render(false)
    expect(await filledIn()).toEqual(FILLED)
    await render(true)
    expect(await filledIn()).toEqual(FILLED)
  })

  it('ignores a click beside it once something is put in, and Close keeps it, and its step, for next time', async () => {
    await open([])
    // Moving to a step is not putting anything in.
    await click(nextButton())
    await mouseDown(backdrop())
    expect(dialog()).toBeNull()
    await act(async () => useBotsStore.setState({ newBotOpen: true }))
    await click(stepTab('Look'))
    await fillIn()
    await mouseDown(backdrop())
    expect(dialog()).not.toBeNull()
    await click(dialog()!.querySelector<HTMLElement>('[aria-label="Close"]')!)
    expect(dialog()).toBeNull()
    await act(async () => useBotsStore.setState({ newBotOpen: true }))
    expect(stepNow()).toBe('about')
    expect(await filledIn()).toEqual(FILLED)
  })

  it('starts empty again, on Look, once the bot is made', async () => {
    await open([])
    await fillIn()
    await click(nextButton())
    await click(createButton())
    await act(async () => {})
    expect(dialog()).toBeNull()
    await act(async () => useBotsStore.setState({ newBotOpen: true }))
    expect(stepNow()).toBe('look')
    await click(nextButton())
    expect([nameBox().value, textBox().value]).toEqual(['', ''])
  })
})

describe('Runs on with rows (#673)', () => {
  /** The same model on a subscription and on a paid API key, as `bots.model.choices` gives them to the picker. */
  const PROVIDERS = [
    { id: 'claude', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', thinkingOff: false }] },
    { id: 'pi', instanceId: 'pi:key', label: 'Anthropic API', models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'], thinkingOff: false }] }
  ]
  const SUB = { instanceId: 'claude', model: 'opus' }
  const KEY = { instanceId: 'pi:key', model: 'opus' }
  const withRows = (extra: object = {}, providers: object[] = PROVIDERS) => vi.mocked(fake.client.modelChoices).mockImplementation(async () => ({ models: [], providers, computer: 'this_computer', computers: [{ id: 'this_computer', name: 'Desk' }], ...extra }) as never)
  const rowPicker = (label: string) => dialog()!.querySelector<HTMLButtonElement>(`button[aria-label^="New bot's ${label} model"]`) ?? undefined
  const labels = () => [...dialog()!.querySelectorAll('.bot-new-row > span:first-child, .bot-model-row-label')].map((element) => element.textContent)
  const menu = () => document.querySelector('[role="listbox"][aria-label="Select model"]')
  async function pick(label: string, entry: string) {
    await click(rowPicker(label))
    const option = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.title.includes(entry))
    if (!option()) await click(document.querySelector<HTMLElement>(`[role="tab"][aria-label="${entry}"]`) ?? undefined)
    await click(option())
  }

  it('shows Computer, then Talk and Work, each one picker; the first bot starts empty and Create bot waits for both', async () => {
    withRows()
    await open([])
    await toRunsOn('Remind me to water the plants.')
    expect(labels()).toEqual(['Computer', 'Talk', 'Work'])
    expect(rowPicker('Talk')?.getAttribute('aria-label')).toBe('New bot\'s Talk model: Pick a model')
    // The step's first focusable control: Talk's picker (one computer is plain text).
    expect(document.activeElement).toBe(rowPicker('Talk'))
    expect(createButton()?.disabled).toBe(true)
    expect(createButton()?.title).toBe('Pick a model for Talk and Work')
    await pick('Talk', 'Claude Code')
    expect(createButton()?.disabled).toBe(true)
    await pick('Work', 'Anthropic API')
    expect(createButton()?.disabled).toBe(false)
    await click(createButton())
    await act(async () => {})
    expect(creates()[0]![1]).toMatchObject({ slots: { talk: SUB, light: KEY, medium: KEY, hard: KEY } })
    expect(creates()[0]![1]).not.toHaveProperty('model')
  })

  it('Escape in an open model menu closes the menu, not New bot', async () => {
    withRows()
    await open([])
    await toRunsOn('Remind me to water the plants.')
    await click(rowPicker('Talk'))
    expect(menu()).not.toBeNull()
    await keyDown((document.activeElement as HTMLElement | null) ?? document.body, { key: 'Escape' })
    expect(menu()).toBeNull()
    expect(dialog()).not.toBeNull()
  })

  it('Advanced fits in the step: each kind of work, starting from Work\'s pick', async () => {
    withRows()
    await open([])
    await toRunsOn('Remind me to water the plants.')
    await pick('Talk', 'Claude Code')
    await pick('Work', 'Claude Code')
    await click(dialog()!.querySelector<HTMLElement>('.bot-model-advanced [role="switch"]') ?? undefined)
    expect(labels()).toEqual(['Computer', 'Talk', 'Light work', 'Medium work', 'Hard work'])
    expect(rowPicker('Hard work')?.getAttribute('aria-label')).toBe('New bot\'s Hard work model: Opus · Medium')
    await pick('Hard work', 'Anthropic API')
    await click(createButton())
    await act(async () => {})
    expect(creates()[0]![1]).toMatchObject({ slots: { talk: SUB, light: SUB, medium: SUB, hard: KEY } })
  })

  it('a later bot starts from the owner\'s last picks that are still offered; one no longer offered is empty', async () => {
    withRows({ last: { talk: SUB, light: { instanceId: 'pi:gone', model: 'opus' }, medium: { instanceId: 'pi:gone', model: 'opus' }, hard: { instanceId: 'pi:gone', model: 'opus' } } })
    await open([])
    await toRunsOn('Remind me to water the plants.')
    expect(rowPicker('Talk')?.getAttribute('aria-label')).toBe('New bot\'s Talk model: Opus · Medium')
    expect(rowPicker('Work')?.getAttribute('aria-label')).toBe('New bot\'s Work model: Pick a model')
    expect(createButton()?.disabled).toBe(true)
  })

  it('a pick refused by Create bot returns to Runs on with the message, and that row is empty again', async () => {
    withRows()
    await open([])
    await toRunsOn('Remind me to water the plants.')
    await pick('Talk', 'Claude Code')
    await pick('Work', 'Anthropic API')
    vi.mocked(fake.client.create).mockRejectedValueOnce(Object.assign(new Error('The model you picked is not available now. Pick another one.'), { code: 'model_unavailable' }))
    // The key is gone by then.
    withRows({}, [PROVIDERS[0]!])
    await click(createButton())
    await act(async () => {})
    expect(stepNow()).toBe('runsOn')
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('The model you picked is not available now. Pick another one.')
    expect(rowPicker('Work')?.getAttribute('aria-label')).toBe('New bot\'s Work model: Pick a model')
    expect(rowPicker('Talk')?.getAttribute('aria-label')).toBe('New bot\'s Talk model: Opus · Medium')
    expect(createButton()?.disabled).toBe(true)
  })
})
