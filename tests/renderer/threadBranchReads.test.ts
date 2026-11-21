// @vitest-environment jsdom
/**
 * A thread card's branch survives reads that fail or never answer (a drive asleep, a busy service): it keeps what it
 * showed, reads again later, and a worktree shows the branch Mousse recorded for it until Git answers.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Status = { isRepo: boolean; branch: string | null }
type GitStatus = (scope: { projectId: string; workspaceThreadId: string | null }) => Promise<Status>

let root: Root
let host: HTMLElement
let hook: typeof import('../../src/renderer/hooks/useThreadBranch')

function bridge(git: GitStatus, getStatus: (threadId: string) => Promise<unknown>) {
  ;(window as unknown as { mousse: unknown }).mousse = { git: { status: git }, workspace: { getStatus } }
}

const never = <T,>() => new Promise<T>(() => undefined)
const notAnswering = () => Promise.reject(new Error('The drive or folder at E: is not answering.'))
const ready = (branch: string) => async () => ({ metadata: { branch }, execution: { lifecycle: 'ready' } })

async function show(thread: { projectId: string; worktreeEnabled?: boolean }) {
  const Card = () => {
    const branch = hook.useThreadBranch(thread, 't1')
    return createElement('span', null, branch?.branch ?? '')
  }
  act(() => root.render(createElement(Card)))
  await settle()
}

async function settle() {
  await act(async () => { for (let pass = 0; pass < 8; pass++) await Promise.resolve() })
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({ profileReady: true, warmView: null })
  hook = await import('../../src/renderer/hooks/useThreadBranch')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

it('a read that fails keeps the branch shown, and a first read that fails is tried again until it answers', async () => {
  let answer: () => Promise<Status> = notAnswering
  bridge(() => answer(), never)
  await show({ projectId: 'p1', worktreeEnabled: false })
  expect(host.textContent).toBe('')

  answer = async () => ({ isRepo: true, branch: 'master' })
  await act(async () => { await vi.advanceTimersByTimeAsync(hook.BRANCH_RETRY_MS[0]) })
  expect(host.textContent).toBe('master')

  // Focus reads the project folder again; the drive does not answer this time.
  answer = notAnswering
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await settle()
  expect(host.textContent).toBe('master')
})

it('a worktree thread shows its own branch while its project folder does not answer', async () => {
  bridge((scope) => (scope.workspaceThreadId ? Promise.resolve({ isRepo: true, branch: 'mousse/fix-build' }) : notAnswering()), ready('mousse/fix-build'))
  await show({ projectId: 'p1' })
  expect(host.textContent).toBe('mousse/fix-build')
})

it('a worktree whose Git read never answers shows the branch Mousse recorded, and reads again once it is given up on', async () => {
  let worktree: () => Promise<Status> = never
  bridge((scope) => (scope.workspaceThreadId ? worktree() : Promise.resolve({ isRepo: true, branch: 'master' })), ready('mousse/recorded'))
  await show({ projectId: 'p1' })
  expect(host.textContent).toBe('mousse/recorded')

  worktree = async () => ({ isRepo: true, branch: 'mousse/renamed' })
  await act(async () => { await vi.advanceTimersByTimeAsync(hook.BRANCH_READ_TIMEOUT_MS + hook.BRANCH_RETRY_MS[0]) })
  expect(host.textContent).toBe('mousse/renamed')
})
