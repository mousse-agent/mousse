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
import { PromptUndoButton, PromptUndoNotice, PromptUndoProvider } from '../src/renderer/components/PromptUndoControls'
import { isSessionClosing } from '../src/renderer/lib/errorText'

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
  expect(older).toBeNull()
  await (hooks.context as { undo: (messageId: string) => Promise<void> }).undo('prompt-older')
  expect(undoLatest).not.toHaveBeenCalled()
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
  render()
  const notice = PromptUndoNotice()!
  expect(notice.props.role).toBe('alert')
  expect(notice.props.className).toBe('connection-failed-pill')
  expect(notice.props.children[0].props.children).toBe('Checkpoint is unavailable')
  expect(PromptUndoButton({ messageId: target.messageId }).props.disabled).toBe(false)
  expect(undoLatest).toHaveBeenCalledTimes(1)
})

it('uses authoritative conversation redo after Undo hides the prompt', async () => {
  const redoTarget = { actionId: 'undone', turnId: target.turnId, journalGeneration: 8 }
  const { redo } = await mount(vi.fn().mockResolvedValue({ ...history, undoTarget: undefined, redoTarget }))
  render()
  const notice = PromptUndoNotice()!
  expect(notice.props.className).toContain('connection-failed-pill')
  const button = notice.props.children.find((child: any) => child?.type === 'button')
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

it.each([
  'History offline',
  "Error invoking remote method 'actions:list': Error: Window MMS session is closing"
])('hides Undo and shows no text after a failed background read (%s)', async (message) => {
  const list = vi.fn().mockRejectedValue(new Error(message))
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined, mousse: { actions: { list } } })
  render()
  await vi.waitFor(() => expect(list).toHaveBeenCalled())
  await new Promise(resolve => setTimeout(resolve, 0))
  const tree = render()
  expect(hooks.states[2]).toBeNull()
  expect(PromptUndoButton({ messageId: target.messageId })).toBeNull()
  // The provider adds nothing beside the chat, and the composer notice stays empty.
  expect(tree.props.children).toBeNull()
  expect(PromptUndoNotice()).toBeNull()
})

it('says nothing when Undo fails because the window is closing', async () => {
  const closing = new Error("Error invoking remote method 'actions:undoLatest': Error: Window MMS session is closing")
  const { undoLatest } = await mount(vi.fn().mockResolvedValue(history), vi.fn().mockRejectedValue(closing))
  PromptUndoButton({ messageId: target.messageId }).props.onClick()
  await vi.waitFor(() => expect(undoLatest).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(hooks.states[1]).toBe(false))
  render()
  expect(hooks.states[2]).toBeNull()
  expect(PromptUndoNotice()).toBeNull()
})

it('shows a failed Undo without the IPC prefix', async () => {
  const failure = new Error("Error invoking remote method 'actions:undoLatest': Error: Checkpoint is unavailable")
  await mount(vi.fn().mockResolvedValue(history), vi.fn().mockRejectedValue(failure))
  PromptUndoButton({ messageId: target.messageId }).props.onClick()
  await vi.waitFor(() => expect(hooks.states[2]).toBe('Checkpoint is unavailable'))
})

it('offers Discard for an Undo refused over a conflict, runs it only after confirmation, then undoes again', async () => {
  const refusal = { code: 'workspace_conflict', message: 'Thread workspace /w has a merge in progress with conflicts in notes.md. Resolve it or discard the changes, then try again.',
    details: { label: 'Thread workspace', path: '/w', files: ['notes.md'], count: 1, conflict: true, operation: 'merge', discard: true } }
  const undoLatest = vi.fn().mockResolvedValueOnce({ pendingChangesError: refusal }).mockResolvedValue(undefined)
  await mount(vi.fn().mockResolvedValue(history), undoLatest)
  const discardPendingChanges = vi.fn(async () => ({ backupRef: 'refs/mousse/discarded/x' }))
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
  Object.assign(window, { confirm, mousse: { ...window.mousse, workspace: { discardPendingChanges } } })
  PromptUndoButton({ messageId: target.messageId }).props.onClick()
  await vi.waitFor(() => expect(hooks.states[2]).toBe(refusal.message))
  render()
  const notice = PromptUndoNotice()!
  expect(notice.props.details).toEqual(refusal.details)
  expect(notice.props.message).toBe(refusal.message)
  const shown = notice.type(notice.props)
  const buttons = shown.props.children.filter((child: any) => child?.type === 'button')
  expect(buttons.map((button: any) => button.props.children)).toEqual(['Discard'])
  buttons[0].props.onClick()
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Discard 1 changed file in /w? The unfinished merge is ended too.'))
  expect(discardPendingChanges).not.toHaveBeenCalled()
  buttons[0].props.onClick()
  await vi.waitFor(() => expect(discardPendingChanges).toHaveBeenCalledExactlyOnceWith(threadId))
  await vi.waitFor(() => expect(undoLatest).toHaveBeenCalledTimes(2))
})

it('recognises a closing window connection only by the messages main sends for it', () => {
  expect(isSessionClosing(new Error("Error invoking remote method 'threads:initialize': Error: Window MMS session is closing"))).toBe(true)
  expect(isSessionClosing(new Error('Window MMS session closed while opening'))).toBe(true)
  expect(isSessionClosing({ message: 'GuiMmsController is stopped' })).toBe(true)
  expect(isSessionClosing(new Error('MMS client not connected'))).toBe(false)
  expect(isSessionClosing(new Error('Checkpoint is unavailable'))).toBe(false)
})
