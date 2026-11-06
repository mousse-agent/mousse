// @vitest-environment jsdom
/**
 * A signed-out GitHub CLI, mounted: the pull request panel names the step and where to take it, copies the fixed
 * command and says whether that worked, and Try again reads again; the Start from pull request dialog says it in
 * one muted line, without the CLI's text or a path, and other failures keep their own message.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PullRequestPanelView } from '../../src/renderer/components/PullRequestPanel'
import { StartFromPullRequestDialog } from '../../src/renderer/components/StartFromPullRequestDialog'
import { NO_COMPUTERS, useComputersStore, type ComputersState } from '../../src/renderer/lib/computers'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Project } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/lib/threadActions', () => ({
  openThreadFromPullRequest: vi.fn(async () => undefined),
  selectThread: vi.fn(async () => undefined)
}))

const RAW = 'To get started with GitHub CLI, please run:  gh auth login — not signed in to github.com for /Users/ada/code/app.'

let host: HTMLDivElement
let root: Root
const render = async (element: ReturnType<typeof createElement>) => {
  await act(async () => root.render(element))
}
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('element not found')
  await act(async () => { (element as HTMLElement).click() })
}
const button = (text: string) => [...document.body.querySelectorAll('button')].find((item) => item.textContent?.includes(text))
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
  useComputersStore.setState(NO_COMPUTERS)
  useAppStore.setState({ projects: [] })
})

describe('the pull request panel while GitHub CLI is signed out', () => {
  it('copies only the sign-in command and says so, then clears the note', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await render(createElement(PullRequestPanelView, { state: { kind: 'signed-out', message: RAW } }))
    const notice = document.body.querySelector('.pr-panel-signin')!
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.querySelector('.pr-panel-signin-title')?.textContent).toBe('Sign in to GitHub CLI')
    // The raw text is only under Details, which starts closed.
    expect(notice.querySelector('details')?.open).toBe(false)
    expect(notice.querySelector('.pr-panel-signin-title')?.textContent).not.toContain('/Users/ada')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click(button('Copy command'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(writeText).toHaveBeenCalledExactlyOnceWith('gh auth login')
    expect(button('Copied')).toBeDefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(button('Copied')).toBeUndefined()
    expect(button('Copy command')).toBeDefined()
  })

  it('says when the copy failed', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    await render(createElement(PullRequestPanelView, { state: { kind: 'signed-out', message: RAW } }))
    await click(button('Copy command'))
    await settle()
    expect(document.body.querySelector('.pr-panel-signin-failed')?.textContent).toBe('Could not copy. Select the command and copy it.')
  })

  it('reads again on Try again', async () => {
    const onRefresh = vi.fn()
    await render(createElement(PullRequestPanelView, { state: { kind: 'signed-out', message: RAW }, onRefresh }))
    await click(button('Try again'))
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})

describe('starting from a pull request while GitHub CLI is signed out', () => {
  const signedOut = { code: 'pull_request_unavailable', message: RAW, details: { reason: 'unauthenticated' }, name: 'StorageRequestError' }
  const stub = (list: () => Promise<unknown>) => vi.stubGlobal('mousse', { pullRequests: { list: vi.fn(list), resolve: vi.fn(() => new Promise(() => {})) } })

  it('says it in one muted line, without the CLI\'s text, and asks only for a URL or number', async () => {
    stub(async () => { throw signedOut })
    await render(createElement(StartFromPullRequestDialog, { projectId: 'p1', projectName: 'app', onClose: () => undefined }))
    await settle()
    const list = document.body.querySelector('.start-from-pr-list')!
    expect(list.textContent).toBe('Sign in to GitHub CLI to search pull requests')
    expect(list.querySelector('.start-from-pr-quiet')?.getAttribute('title')).toBe('Run gh auth login in a terminal')
    expect(document.body.querySelector('.start-from-pr-error')).toBeNull()
    expect(document.body.textContent).not.toContain('/Users/ada')
    expect(document.body.querySelector('.start-from-pr-input')?.getAttribute('placeholder')).toBe('PR URL or number')
    // Nothing to say yet: the status strip is empty, so it takes no room.
    expect(document.body.querySelector('.start-from-pr-status')?.childNodes).toHaveLength(0)
  })

  it('names the computer that holds a project of another computer', async () => {
    useAppStore.setState({ projects: [{ id: 'p1', name: 'app', path: '/srv/app', node: 'n1' } as Project] })
    useComputersStore.setState({ ...NO_COMPUTERS, byNode: { n1: { name: 'Mac mini' } } as unknown as ComputersState['byNode'] })
    stub(async () => { throw signedOut })
    await render(createElement(StartFromPullRequestDialog, { projectId: 'p1', projectName: 'app', onClose: () => undefined }))
    await settle()
    expect(document.body.querySelector('.start-from-pr-lead')?.textContent).toBe('app on Mac mini · Starts in its own worktree')
    expect(document.body.querySelector('.start-from-pr-list .start-from-pr-quiet')?.getAttribute('title')).toBe('Run gh auth login in a terminal on Mac mini')
  })

  it('keeps the real message of any other failure', async () => {
    stub(async () => { throw { code: 'pull_request_unavailable', message: 'HTTP 502: Bad gateway', details: { reason: 'error' } } })
    await render(createElement(StartFromPullRequestDialog, { projectId: 'p1', projectName: 'app', onClose: () => undefined }))
    await settle()
    expect(document.body.querySelector('.start-from-pr-list .start-from-pr-error')?.textContent).toBe('HTTP 502: Bad gateway')
    expect(document.body.querySelector('.start-from-pr-input')?.getAttribute('placeholder')).toContain('search below')
  })
})
