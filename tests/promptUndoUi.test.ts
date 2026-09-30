import { beforeEach, afterEach, expect, it, vi } from 'vitest'

// Exercise the production provider and the exact prompt button without a DOM.
// Electron qualification separately mounts the full shell and clicks this control.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], stateIndex: 0, refIndex: 0, effects: [] as (() => unknown)[], mount: true, context: null as unknown, profileId: 'prompt-test' }))
vi.mock('react', async load => ({
  ...await load<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++
    if (!(index in hooks.states)) hooks.states[index] = initial
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = value }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ?? (hooks.refs[hooks.refIndex - 1] = { current: initial }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => { if (hooks.mount) hooks.effects.push(effect) },
  useContext: () => hooks.context
}))
vi.mock('../src/renderer/stores/appStore', () => {
  const state = { get profileId() { return hooks.profileId } }
  return { useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state, subscribe: () => () => undefined }) }
})
import { PromptUndoButton, PromptUndoProvider } from '../src/renderer/components/PromptUndoControls'

const target = { actionId: 'action-latest', turnId: 'turn-latest', messageId: 'prompt-latest', journalGeneration: 7 }
const history = { actions: [], receipts: [], journalGeneration: 7, undoTarget: target }
let task = 0
let threadId = ''
const cleanups: Array<() => void> = []
function render(busy = false) {
  hooks.stateIndex = 0; hooks.refIndex = 0
  const tree = PromptUndoProvider({ threadId, busy, revision: 'stable', children: null })
  hooks.context = tree.props.value
  for (const effect of hooks.effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup as () => void) }
  hooks.mount = false
  return tree
}
async function mount(list: ReturnType<typeof vi.fn>, undoLatest = vi.fn(async () => undefined), redo = vi.fn(async () => undefined)) {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined, mousse: { actions: { list, undoLatest, redo } } })
  render()
  await vi.waitFor(() => expect(hooks.states[0]).not.toBeNull())
  render()
  return { undoLatest, redo }
}
beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.mount = true; hooks.context = null
  hooks.profileId = 'prompt-test'
  threadId = `prompt-test-${++task}`
})
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals() })

it('clicks the actual latest-prompt Undo with its exact turn and generation, without editing transcript data', async () => {
  const list = vi.fn().mockResolvedValueOnce(history).mockResolvedValueOnce(history).mockResolvedValue({ ...history, undoTarget: undefined })
  const { undoLatest } = await mount(list)
  const button = PromptUndoButton({ messageId: target.messageId })
  expect(button.props['aria-label']).toBe('Undo')
  expect(button.props.disabled).toBe(false)
  button.props.onClick(); button.props.onClick()
  await vi.waitFor(() => expect(undoLatest).toHaveBeenCalledExactlyOnceWith(threadId, 7, 'turn-latest'))
  await vi.waitFor(() => expect(hooks.states[1]).toBe(false))
  expect(list).toHaveBeenCalledTimes(3)
})

it('keeps historical and active prompts unavailable and rejects a changed target before dispatch', async () => {
  const list = vi.fn().mockResolvedValueOnce(history).mockResolvedValue({ ...history, undoTarget: { ...target, turnId: 'new-turn', journalGeneration: 8 } })
  const { undoLatest } = await mount(list)
  const older = PromptUndoButton({ messageId: 'prompt-older' })
  expect(older.props.disabled).toBe(true); older.props.onClick()
  render(true)
  const active = PromptUndoButton({ messageId: target.messageId })
  expect(active.props.disabled).toBe(true); active.props.onClick()
  render(false)
  PromptUndoButton({ messageId: target.messageId }).props.onClick()
  await vi.waitFor(() => expect(hooks.states[2]).toContain('Conversation history changed'))
  expect(undoLatest).not.toHaveBeenCalled()
})

it('shows backend failure and leaves the prompt available rather than deleting it locally', async () => {
  const { undoLatest } = await mount(vi.fn().mockResolvedValue(history), vi.fn().mockRejectedValue(new Error('Checkpoint is unavailable')))
  PromptUndoButton({ messageId: target.messageId }).props.onClick()
  await vi.waitFor(() => expect(hooks.states[2]).toBe('Checkpoint is unavailable'))
  const tree = render()
  expect(tree.props.children.some((child: any) => child?.props?.role === 'alert')).toBe(true)
  expect(PromptUndoButton({ messageId: target.messageId }).props.disabled).toBe(false)
  expect(undoLatest).toHaveBeenCalledTimes(1)
})

it('uses authoritative conversation redo after Undo hides the prompt', async () => {
  const redoTarget = { actionId: 'undone', turnId: target.turnId, journalGeneration: 8 }
  const { redo } = await mount(vi.fn().mockResolvedValue({ ...history, undoTarget: undefined, redoTarget }))
  const button = render().props.children.find((child: any) => child?.type === 'button')
  expect(button.props.children).toBe('Redo last undo')
  button.props.onClick()
  await vi.waitFor(() => expect(redo).toHaveBeenCalledExactlyOnceWith(threadId, 8))
})

it('does not let a completion from an unmounted profile alter the new binding', async () => {
  let complete!: () => void
  const oldUndo = vi.fn(() => new Promise<void>(resolve => { complete = resolve }))
  await mount(vi.fn().mockResolvedValue(history), oldUndo)
  PromptUndoButton({ messageId: target.messageId }).props.onClick()
  await vi.waitFor(() => expect(oldUndo).toHaveBeenCalledTimes(1))
  // MousseAgentChatShell keys the provider by profile and thread: remount hooks.
  for (const cleanup of cleanups.splice(0)) cleanup()
  hooks.profileId = 'new-profile'; hooks.states = []; hooks.refs = []; hooks.mount = true
  await mount(vi.fn().mockResolvedValue(history))
  complete()
  await new Promise(resolve => setTimeout(resolve, 0))
  render()
  expect(hooks.states[1]).toBe(false)
  expect(hooks.states[2]).toBeNull()
  expect(PromptUndoButton({ messageId: target.messageId }).props.disabled).toBe(false)
})

it('explains unavailable history instead of leaving a checking tooltip after failure', async () => {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined, mousse: { actions: { list: vi.fn().mockRejectedValue(new Error('History offline')) } } })
  render()
  await vi.waitFor(() => expect(hooks.states[2]).toBe('History offline'))
  render()
  const button = PromptUndoButton({ messageId: target.messageId })
  expect(button.props.disabled).toBe(true)
  expect(button.props.title).toBe('Undo unavailable: History offline')
})
