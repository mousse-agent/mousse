// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ComposerNotice,
  ComposerNoticeProvider,
  ComposerNoticeSlot,
  ComposerNoticeSource,
  ComposerNoticeStore,
  type ComposerNoticeProps
} from '../../src/renderer/components/ComposerNotice'
import { PendingChangesNotice, discardDialogText } from '../../src/renderer/components/PendingChangesNotice'
import { ServiceLostNotice } from '../../src/renderer/components/ServiceLostNotice'
import type { PendingChangesDetails } from '../../src/shared/workspace'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const shown = () => Array.from(host.querySelectorAll<HTMLElement>('.composer-notice'))
const title = () => host.querySelector('.composer-notice-title')?.textContent
const byName = (scope: ParentNode, name: string) => Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
  .find((entry) => (entry.getAttribute('aria-label') ?? entry.textContent) === name)
const click = (target: Element | undefined) => act(() => { (target as HTMLElement).click() })
const render = (...children: ReactNode[]) => act(() => root.render(
  createElement(ComposerNoticeProvider, null, createElement(Fragment, null, createElement(ComposerNoticeSlot), ...children))
))
const source = (key: string, notice: ComposerNoticeProps | null) => createElement(ComposerNoticeSource, { key, notice })

describe('the notice store', () => {
  const notice = (tone: ComposerNoticeProps['tone'], title: string): ComposerNoticeProps => ({ tone, title })

  it('puts the most severe notice on top, then the newest of that tone', () => {
    const store = new ComposerNoticeStore()
    store.set('undo', notice('info', 'Turn undone'))
    store.set('paused', notice('warning', 'Paused'))
    expect(store.top()?.title).toBe('Paused')
    store.set('send', notice('error', 'Send failed'))
    store.set('queue', notice('error', 'Queue failed'))
    expect(store.top()?.title).toBe('Queue failed')
    // Updating an older notice does not make it newer.
    store.set('send', notice('error', 'Send failed again'))
    expect(store.top()?.title).toBe('Queue failed')
    store.set('queue', null)
    expect(store.top()?.title).toBe('Send failed again')
    store.set('send', null)
    store.set('paused', null)
    expect(store.top()?.title).toBe('Turn undone')
    store.set('undo', null)
    expect(store.top()).toBeNull()
  })

  it('tells the slot only when what it shows changes', () => {
    const store = new ComposerNoticeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const error = notice('error', 'Send failed')
    store.set('send', error)
    store.set('undo', notice('info', 'Turn undone'))
    store.set('send', error)
    store.set('gone', null)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stacks only the lost service above a waiting approval; otherwise it is one row like the rest', () => {
    const store = new ComposerNoticeStore()
    const service: ComposerNoticeProps = { tone: 'error', title: 'Service lost', priority: 'service' }
    const approval: ComposerNoticeProps = { tone: 'warning', title: 'Approval', priority: 'approval' }
    store.set('send', notice('error', 'Send failed'))
    store.set('service', service)
    // No approval: the lost service wins, nothing stacks.
    expect(store.top()?.title).toBe('Service lost')
    expect(store.above()).toBeNull()
    store.set('approval', approval)
    expect(store.top()?.title).toBe('Approval')
    expect(store.above()?.title).toBe('Service lost')
    // An ordinary error still waits behind the approval.
    store.set('service', null)
    expect(store.top()?.title).toBe('Approval')
    expect(store.above()).toBeNull()
    // A paused run outranks the approval, so the lost service shows alone.
    store.set('service', service)
    store.set('paused', { tone: 'warning', title: 'Paused', priority: 'paused' })
    expect(store.top()?.title).toBe('Service lost')
    expect(store.above()).toBeNull()
    store.set('paused', null)
    store.set('approval', null)
    expect(store.top()?.title).toBe('Service lost')
    expect(store.above()).toBeNull()
  })
})

describe('the notice slot', () => {
  it('shows one line at a time; dismissing an error reveals the undo notice under it', () => {
    let error: ComposerNoticeProps | null = { tone: 'error', title: 'Could not send', onDismiss: () => { error = null; draw() } }
    const draw = () => render(
      source('undo', { tone: 'info', title: 'Turn undone', actions: [{ label: 'Redo', onClick: () => undefined }] }),
      source('send', error)
    )
    draw()
    expect(shown()).toHaveLength(1)
    expect(shown()[0].dataset.tone).toBe('error')
    expect(title()).toBe('Could not send')
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    click(byName(host, 'Dismiss'))
    expect(shown()).toHaveLength(1)
    expect(title()).toBe('Turn undone')
    expect(host.querySelector('[role="status"]')).not.toBeNull()
    expect(byName(host, 'Redo')).toBeDefined()
  })

  it('draws the lost service on its own line above a waiting approval, each marked with its priority', () => {
    render(
      source('approval', { tone: 'warning', title: 'Approval', priority: 'approval' }),
      source('service', { tone: 'error', title: 'Service lost', priority: 'service' })
    )
    expect(shown().map((line) => [line.dataset.priority, line.getAttribute('aria-label')])).toEqual([['service', 'Service lost'], ['approval', 'Approval']])
  })

  it('a notice that resolves leaves the slot empty', () => {
    render(source('progress', { tone: 'info', title: 'Updating conversation…' }))
    expect(title()).toBe('Updating conversation…')
    render(source('progress', null))
    expect(shown()).toHaveLength(0)
  })

  it('without a provider a source shows nothing and does not fail', () => {
    act(() => root.render(createElement(Fragment, null, createElement(ComposerNoticeSlot), source('x', { tone: 'error', title: 'Lost' }))))
    expect(shown()).toHaveLength(0)
  })
})

describe('one notice', () => {
  const draw = (notice: ComposerNoticeProps) => act(() => root.render(createElement(ComposerNotice, notice)))

  it('an icon action is a labelled icon button; an uncommon one keeps its text', () => {
    const retry = vi.fn()
    draw({ tone: 'error', title: 'Could not send', actions: [{ label: 'Retry', icon: createElement('svg'), onClick: retry }] })
    const button = byName(host, 'Retry')!
    expect(button.textContent).toBe('')
    expect(button.title).toBe('Retry')
    click(button)
    expect(retry).toHaveBeenCalledTimes(1)
    draw({ tone: 'error', title: 'Update Mousse on Studio to do this.', actions: [{ label: 'Update Studio…', onClick: () => undefined }] })
    expect(byName(host, 'Update Studio…')!.textContent).toBe('Update Studio…')
  })

  it('room for an approval: a quieter detail, two actions and a jump icon', () => {
    const jump = vi.fn()
    draw({
      tone: 'warning', title: 'Approval', detail: 'Run npm test',
      actions: [{ label: 'Deny', onClick: () => undefined }, { label: 'Approve', onClick: () => undefined }],
      onJump: jump, jumpLabel: 'Show the request'
    })
    expect(host.querySelector('.composer-notice-detail')!.textContent).toBe('Run npm test')
    expect(host.querySelector('.composer-notice-text')!.getAttribute('title')).toBe('Approval: Run npm test')
    expect(Array.from(host.querySelectorAll('button')).map((entry) => entry.getAttribute('aria-label') ?? entry.textContent))
      .toEqual(['Deny', 'Approve', 'Show the request'])
    click(byName(host, 'Show the request'))
    expect(jump).toHaveBeenCalledTimes(1)
  })
})

describe('the background service notice', () => {
  const draw = (lost: boolean, onReconnect = vi.fn(), onDismiss = vi.fn()) =>
    render(createElement(ServiceLostNotice, { key: 'service', lost, onReconnect, onDismiss }))

  it('names the background service, not "connection", and explains in the tooltip', () => {
    const onReconnect = vi.fn()
    draw(true, onReconnect)
    const [line] = shown()
    expect(line.getAttribute('data-tone')).toBe('error')
    expect(line.querySelector('.composer-notice-title-full')!.textContent).toBe("Can't reach Mousse's background service")
    expect(line.querySelector('.composer-notice-title-short')!.textContent).toBe('Background service unreachable')
    expect(line.getAttribute('aria-label')).toBe("Can't reach Mousse's background service")
    expect(line.querySelector('.composer-notice-text')!.getAttribute('title')).toBe(
      'This window lost its link to the Mousse service that runs your agents. Agents may still be running. Nothing you send reaches them until it reconnects.'
    )
    expect(line.textContent).not.toMatch(/connection lost/i)
    const reconnect = byName(line, 'Reconnect')!
    expect(reconnect.title).toBe('Reconnect')
    expect(reconnect.querySelector('svg')).not.toBeNull()
    click(reconnect)
    expect(onReconnect).toHaveBeenCalledTimes(1)
    draw(false)
    expect(shown()).toHaveLength(0)
  })

  it('shows the shorter title when the line is narrow', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8')
    expect(css).toMatch(/\.composer-notice-slot\s*\{[^}]*container:\s*composer-notice \/ inline-size;/)
    expect(css).toMatch(/\.composer-notice-title-short\s*\{\s*display:\s*none;/)
    const narrow = css.slice(css.indexOf('@container composer-notice (max-width: 420px)'))
    expect(narrow).toMatch(/^@container composer-notice[^{]*\{\s*\.composer-notice-title-full\s*\{\s*display:\s*none;\s*\}\s*\.composer-notice-title-short\s*\{\s*display:\s*inline;/)
  })
})

describe('the dock on the composer', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8')
  const body = (selector: string) => {
    const start = css.indexOf(`${selector} {`)
    expect(start, selector).toBeGreaterThanOrEqual(0)
    return css.slice(start, css.indexOf('}', start))
  }

  it('docks the queue on the composer: its surface, flush on its top edge', () => {
    const queue = body('.chat-input-area > .queued-messages')
    expect(queue).toMatch(/margin:\s*0;/)
    expect(queue).toMatch(/border:\s*1px solid var\(--ui-line-strong\);\s*border-bottom:\s*0;/)
    expect(queue).toMatch(/border-radius:\s*16px 16px 0 0;/)
    expect(queue).toMatch(/background:\s*var\(--ui-raised\);/)
    expect(body('.app .chat-input-area:has(> .queued-messages):not(:has(> .new-thread-row)) .composer'))
      .toMatch(/border-top-left-radius:\s*0;\s*border-top-right-radius:\s*0;/)
  })

  it('draws a notice as one quiet line: no border, fill, shadow or corners, muted metadata text, plain text actions', () => {
    // Both appear and fade in the same way.
    expect(body('.chat-input-area > :is(.composer-notice-slot, .queued-messages)')).toMatch(/animation:\s*composer-dock-in/)
    const rules = [...css.matchAll(/([^{}]*\.composer-notice[^{}]*)\{([^}]*)\}/g)].map(([, selector, declarations]) => ({ selector: selector.trim(), declarations }))
    expect(rules.length).toBeGreaterThan(5)
    for (const { selector, declarations } of rules) {
      // Buttons keep their rounded hover shape and their focus ring; nothing else draws an edge.
      if (!/:focus-visible/.test(selector)) expect(declarations, selector).not.toMatch(/(^|;)\s*(border(?!-radius)(-[a-z]+)*|box-shadow)\s*:(?!\s*(0|none);)/)
      // A fill only on hover and press.
      if (!/:(hover|active)/.test(selector)) expect(declarations, selector).not.toMatch(/background(-color)?\s*:(?!\s*transparent;)/)
    }
    expect(css).not.toMatch(/:has\([^)]*\.composer-notice-slot[^)]*\)[^{]*\.composer\s*\{/)
    const line = body('.composer-notice')
    expect(line).toMatch(/color:\s*var\(--text-secondary\);/)
    expect(line).toMatch(/font-size:\s*12\.5px;/)
    expect(body('.composer-notice-btn-primary')).toMatch(/color:\s*color-mix\(in srgb, var\(--accent\)/)
  })

  it('sits in the composer stack, so the transcript keeps clear of it without an offset of its own', () => {
    expect(body('.composer-notice-slot')).not.toMatch(/position:\s*absolute/)
    const polish = readFileSync(resolve(process.cwd(), 'src/renderer/styles/polish.css'), 'utf8')
    expect(polish).not.toContain('--chat-notice-stack')
  })
})

describe('Discard from a notice', () => {
  const details: PendingChangesDetails = { label: 'Thread workspace', path: '/w', files: ['a.ts', 'b.ts', 'c.ts'], count: 3, conflict: true, operation: 'merge', discard: true }
  const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')

  it('says what goes and how to get it back, in a title and one line', () => {
    expect(discardDialogText(details)).toEqual({ title: 'Discard 3 changed files?', line: 'A copy stays in Git while Undo can reach it. The unfinished merge ends too.' })
    expect(discardDialogText({ ...details, count: 1, operation: undefined })).toEqual({ title: 'Discard 1 changed file?', line: 'A copy stays in Git while Undo can reach it.' })
  })

  it('asks in an app dialog; Cancel discards nothing, Discard drops the changes and retries', async () => {
    const discardPendingChanges = vi.fn(async () => ({ backupRef: 'refs/x', notice: '' }))
    ;(window as unknown as { mousse: unknown }).mousse = { workspace: { discardPendingChanges } }
    const onResolved = vi.fn()
    render(createElement(PendingChangesNotice, { key: 'changes', threadId: 't1', message: 'Thread workspace /w has a merge in progress.', details, onResolved }))
    expect(title()).toBe('Thread workspace /w has a merge in progress.')
    expect(dialog()).toBeNull()

    click(byName(host, 'Discard'))
    expect(dialog()!.textContent).toContain('Discard 3 changed files?')
    click(byName(dialog()!, 'Cancel'))
    expect(dialog()).toBeNull()
    expect(discardPendingChanges).not.toHaveBeenCalled()

    click(byName(host, 'Discard'))
    await act(async () => { byName(dialog()!, 'Discard')!.click(); await Promise.resolve() })
    expect(dialog()).toBeNull()
    expect(discardPendingChanges).toHaveBeenCalledExactlyOnceWith('t1')
    expect(onResolved).toHaveBeenCalledTimes(1)
  })

  it('names the files that changed after Discard was pressed, and keeps Discard offered', async () => {
    const discardPendingChanges = vi.fn(async () => ({ backupRef: 'refs/x', notice: '', left: 'a.ts changed while discarding. It was left as it is.' }))
    ;(window as unknown as { mousse: unknown }).mousse = { workspace: { discardPendingChanges } }
    const onResolved = vi.fn()
    render(createElement(PendingChangesNotice, { key: 'changes', threadId: 't1', message: 'Conflict.', details, onResolved }))
    click(byName(host, 'Discard'))
    await act(async () => { byName(dialog()!, 'Discard')!.click(); await Promise.resolve() })
    expect(title()).toBe('a.ts changed while discarding. It was left as it is.')
    expect(byName(host, 'Discard')).toBeDefined()
    expect(onResolved).not.toHaveBeenCalled()
  })
})
