// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SourceControlProviderStatus } from '../../src/shared/sourceControl'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SourceControlSettings } = await import('../../src/renderer/components/settings/SourceControlSettings')
const { useSourceControl } = await import('../../src/renderer/lib/sourceControl')

let host: HTMLDivElement
let root: Root
let github: SourceControlProviderStatus
const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
  if (method === 'sourceControl.status') return { providers: [github] }
  if (method === 'sourceControl.connect') {
    github = { ...github, operation: { id: 'op1', phase: 'starting' } }
    return github
  }
  if (method === 'sourceControl.signOut') {
    github = { id: 'github', name: 'GitHub', state: 'signed-out' }
    return github
  }
  if (method === 'sourceControl.repositories') return { repositories: [], fetchedAt: 1 }
  throw new Error(`unexpected ${method}`)
})

beforeEach(() => {
  request.mockClear()
  useSourceControl.setState({ computers: {} })
  Object.assign(window, { mousse: { platformRequest: { request } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const show = async () => {
  await act(async () => root.render(createElement(SourceControlSettings)))
}
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === name || entry.getAttribute('aria-label') === name)
const addGitHub = async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add an account"]')!.click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent?.includes('GitHub'))!
  await act(async () => option.click())
}

it('shows a gh that is already signed in as connected, with its account, and signs it out', async () => {
  github = { id: 'github', name: 'GitHub', state: 'connected', account: 'octo-cat' }
  await show()
  expect(host.textContent).toContain('octo-cat')
  expect(host.querySelector('[aria-label="Add an account"]')).toBeNull()
  await act(async () => button('Sign out')!.click())
  expect(request).toHaveBeenCalledWith('sourceControl.signOut', { provider: 'github' })
  expect(host.textContent).toContain('No accounts yet.')
})

it('adds GitHub: shows the install command first, then the one-time code to enter on GitHub', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  github = { id: 'github', name: 'GitHub', state: 'missing', install: { via: 'winget', automatic: true, command: 'winget install --id GitHub.cli --exact --source winget', url: 'https://github.com/cli/cli#installation' } }
  await show()
  expect(host.textContent).toContain('No accounts yet.')
  await addGitHub()
  expect(host.textContent).toContain('winget install --id GitHub.cli')
  await act(async () => button('Install and connect')!.click())
  expect(request).toHaveBeenCalledWith('sourceControl.connect', { provider: 'github' })
  expect(host.textContent).toContain('Starting sign-in…')
  github = { ...github, operation: { id: 'op1', phase: 'code', code: 'AB12-CD34', url: 'https://github.com/login/device' } }
  await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
  expect(host.querySelector('[aria-label="One-time code"]')!.textContent).toBe('AB12-CD34')
  expect(button('Open GitHub')).toBeDefined()
  github = { id: 'github', name: 'GitHub', state: 'connected', account: 'octo-cat' }
  await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
  expect(host.textContent).toContain('Connected')
  expect(host.textContent).toContain('octo-cat')
})

it("shows gh's reason when Connect failed, with Connect to try again", async () => {
  github = { id: 'github', name: 'GitHub', state: 'signed-out', error: 'GitHub sign-in failed: authorization was denied' }
  await show()
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('authorization was denied')
  expect(button('Connect')).toBeDefined()
})
