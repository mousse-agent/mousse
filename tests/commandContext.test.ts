import { describe, expect, it } from 'vitest'
import { commandContextFromDom, type ClosestTarget, type CommandStateSlice, type OverlayState } from '../src/renderer/commands/commandContext'

/** An element that matches the given selectors, answering `closest` for any query that names one of them. */
const element = (...matching: string[]): ClosestTarget => ({
  closest: (selector) => (selector.split(',').some((part) => matching.includes(part.trim())) ? {} : null)
})

const state = (over: Partial<CommandStateSlice> = {}): CommandStateSlice => ({
  activeThreadId: 'thread-1',
  turnStates: { 'thread-1': { threadId: 'thread-1', phase: 'streaming' } as CommandStateSlice['turnStates'][string] },
  mainAreaOpen: true,
  sidebarMode: 'projects',
  appInfo: { platform: 'win32', repoRoot: '', llmProvider: '' },
  ...over
})

const noOverlay: OverlayState = { modalOpen: false, stack: [] }

describe('commandContextFromDom focus flags', () => {
  it('finds a Monaco editor by its textarea', () => {
    const context = commandContextFromDom(element('textarea'), state(), noOverlay)
    expect(context).toMatchObject({ inTextInput: true, inTerminal: false })
  })

  it('marks xterm as both a text field and a terminal', () => {
    const context = commandContextFromDom(element('textarea', '.xterm'), state(), noOverlay)
    expect(context).toMatchObject({ inTextInput: true, inTerminal: true })
  })

  it('finds inputs and contenteditable elements', () => {
    expect(commandContextFromDom(element('input'), state(), noOverlay).inTextInput).toBe(true)
    expect(commandContextFromDom(element('[contenteditable="true"]'), state(), noOverlay).inTextInput).toBe(true)
  })

  it('treats a button, a missing target and a run without a key press as no field', () => {
    for (const target of [element('button'), null]) {
      expect(commandContextFromDom(target, state(), noOverlay)).toMatchObject({ inTextInput: false, inTerminal: false })
    }
  })
})

describe('commandContextFromDom overlay', () => {
  it('is null when nothing is open', () => {
    expect(commandContextFromDom(null, state(), noOverlay).overlay).toBeNull()
  })

  it('is the top of the stack', () => {
    expect(commandContextFromDom(null, state(), { modalOpen: false, stack: ['model-picker'] }).overlay).toBe('model-picker')
    expect(commandContextFromDom(null, state(), { modalOpen: false, stack: ['thread-search', 'palette'] }).overlay).toBe('palette')
  })

  it('lets an open dialog win over a picker beneath it', () => {
    expect(commandContextFromDom(null, state(), { modalOpen: true, stack: ['model-picker'] }).overlay).toBe('modal')
    expect(commandContextFromDom(null, state(), { modalOpen: true, stack: [] }).overlay).toBe('modal')
  })

  it('leaves out the scope it is asked to ignore', () => {
    expect(commandContextFromDom(null, state(), { modalOpen: false, stack: ['palette'], ignore: 'palette' }).overlay).toBeNull()
    expect(
      commandContextFromDom(null, state(), { modalOpen: false, stack: ['model-picker', 'palette'], ignore: 'palette' }).overlay
    ).toBe('model-picker')
    expect(commandContextFromDom(null, state(), { modalOpen: true, stack: ['palette'], ignore: 'palette' }).overlay).toBe('modal')
  })
})

describe('commandContextFromDom app state', () => {
  it('reads the platform, thread, run and layout', () => {
    expect(commandContextFromDom(null, state(), noOverlay)).toEqual({
      platform: 'win32',
      inTextInput: false,
      inTerminal: false,
      overlay: null,
      threadOpen: true,
      runActive: true,
      mainAreaOpen: true,
      projectsMode: true
    })
  })

  it('has no run active for an idle or finished turn', () => {
    const idle = { 'thread-1': { threadId: 'thread-1', phase: 'idle' } as CommandStateSlice['turnStates'][string] }
    expect(commandContextFromDom(null, state({ turnStates: idle }), noOverlay).runActive).toBe(false)
    expect(commandContextFromDom(null, state({ turnStates: {} }), noOverlay).runActive).toBe(false)
  })

  it('has no thread, run or platform before they are known', () => {
    const context = commandContextFromDom(null, state({ activeThreadId: null, appInfo: null }), noOverlay)
    expect(context).toMatchObject({ threadOpen: false, runActive: false, platform: '' })
  })

  it('follows the sidebar mode and the main area', () => {
    const context = commandContextFromDom(null, state({ sidebarMode: 'chats', mainAreaOpen: false }), noOverlay)
    expect(context).toMatchObject({ projectsMode: false, mainAreaOpen: false })
  })
})
