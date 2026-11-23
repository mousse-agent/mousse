// @vitest-environment jsdom
/**
 * First-run setup: a fresh profile opens Set up Mousse over the window; it connects an AI, picks a
 * project, offers Mousse ID for this computer and a phone (two separate actions), and Done opens a
 * new thread in the picked project and never shows setup again for that profile.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingHost, useOnboarding } from '../../src/renderer/components/onboarding/Onboarding'
import { applySnapshot, useProviderSnapshotsStore } from '../../src/renderer/lib/providerSnapshots'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useMousseIdStore } from '../../src/renderer/stores/mousseIdStore'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { Project } from '../../src/shared/types'
import { snapshot } from '../providerSnapshotFixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROFILE = 'profile-1'
const site: Project = { id: 'p-site', name: 'website', path: '/home/me/website', createdAt: '2026-11-23T10:00:00.000Z', order: 0 }
const draft = { id: 't-draft', name: 'New Chat', projectId: null }
const started = { id: 't-old', name: 'Fix the build', projectId: null, startedAt: '2026-11-20T10:00:00.000Z' }

/** Signed in, networking on, keys protected, and this computer owns the devices list: it can make a phone code. */
const owningNet = { enabled: true, self: { isAuthority: true }, keystore: 'unlocked', protected: true }
const signedIn = { connected: true, email: 'me@example.com' }

let host: HTMLDivElement
let root: Root
let entries: InstanceSnapshot[]
let net: unknown
let plus: unknown
let requests: string[]
const created = vi.fn()

const settle = async () => {
  for (let round = 0; round < 6; round += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
}
const page = () => document.body.querySelector('section[aria-label="Set up Mousse"]')
const button = (name: string) =>
  [...document.body.querySelectorAll('button')].find((item) => item.textContent?.trim() === name) ?? null
const click = async (name: string) => {
  const target = button(name)
  if (!target) throw new Error(`No ${name} button`)
  await act(async () => { target.click() })
  await settle()
}
const heading = () => document.body.querySelector('.onb-title')?.textContent
const rowOf = (title: string) =>
  [...document.body.querySelectorAll('.settings-item')].find((row) => row.textContent?.includes(title)) ?? null

function bridge(options: { openFolder?: Project | null } = {}) {
  ;(window as unknown as { mousse: unknown }).mousse = {
    platform: 'linux',
    window: { isMaximized: async () => false, onMaximizedChange: () => () => {} },
    app: { getInfo: async () => ({ deviceName: 'agibook' }) },
    mousseId: { config: async () => ({ origin: 'https://id.example' }), startCallback: async () => undefined },
    providers: {
      snapshots: async () => entries,
      onSnapshots: () => () => {},
      onOperation: () => () => {},
      catalog: { addOptions: async () => [] },
      instances: {}
    },
    projects: { open: async () => options.openFolder ?? null },
    threads: {
      create: async (...args: unknown[]) => {
        created(...args)
        return { id: 't-new', name: 'New Chat', projectId: args[1] }
      },
      select: async () => {}
    },
    platformRequest: {
      request: async (method: string) => {
        requests.push(method)
        if (method === 'net.status') return net
        if (method === 'net.plus.status') return plus
        if (method === 'net.plus.discover') return {}
        if (method === 'net.plus.login.begin') return { id: 'login-1', userCode: 'QKMT-4821', verificationUri: 'https://id.example/activate', expiresAt: Date.now() + 600_000 }
        // The browser approval never comes back in these tests: the sign-in stays pending.
        if (method === 'net.plus.login.finish') return new Promise(() => {})
        if (method === 'net.plus.login.cancel') return {}
        if (method === 'net.plus.enrollment.offer') return { offerId: 'o1', url: 'mousse://net/join?o=o1', inviteId: 'i1', expiresAt: Date.now() + 300_000 }
        throw new Error(`unexpected ${method}`)
      }
    }
  }
}

async function mount(state: { projects?: Project[]; threads?: unknown[] } = {}) {
  act(() => useAppStore.setState({ profileId: PROFILE, workspaceReady: true, projects: state.projects ?? [], threads: (state.threads ?? [draft]) as never }))
  act(() => root.render(createElement(OnboardingHost)))
  await settle()
}

beforeEach(() => {
  localStorage.clear()
  created.mockClear()
  requests = []
  entries = [snapshot({ auth: { state: 'signed_out', account: undefined } })]
  net = owningNet
  plus = { connected: false }
  useOnboarding.setState({ open: false, step: 0, projectId: null })
  useProviderSnapshotsStore.setState({ profileId: null, scopes: {}, operations: {}, prompts: {} })
  useMousseIdStore.setState({ profileId: null, loaded: false, plus: undefined, net: undefined, runtimeOrigin: 'https://id.example', plusLegacy: undefined, pending: undefined, error: '', busy: false })
  window.open = (() => null) as typeof window.open
  bridge({ openFolder: site })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  useMousseIdStore.getState().cancelSignIn()
  act(() => root.unmount())
  host.remove()
})

describe('when first-run setup opens', () => {
  it.each([
    { profile: 'a fresh profile with only an empty draft', projects: [], threads: [draft], done: false, opens: true },
    { profile: 'a profile that finished or skipped setup', projects: [], threads: [draft], done: true, opens: false },
    { profile: 'a profile with a project', projects: [site], threads: [draft], done: false, opens: false },
    { profile: 'a profile with a started thread', projects: [], threads: [started], done: false, opens: false }
  ])('$profile: opens $opens', async ({ projects, threads, done, opens }) => {
    if (done) localStorage.setItem(`mousse-profile-${PROFILE}-setup.done`, 'done')
    await mount({ projects, threads })
    expect(!!page()).toBe(opens)
  })
})

describe('Set up Mousse', () => {
  it('waits on Connect an AI until an agent is signed in', async () => {
    await mount()
    expect(heading()).toBe('Connect an AI')
    expect(rowOf('Claude Code')?.textContent).toContain('Not signed in')
    expect(button('Continue')?.disabled).toBe(true)

    await act(async () => { applySnapshot(snapshot({ auth: { state: 'signed_in', account: { id: 'a', label: 'me@example.com' } } })) })
    await settle()
    expect(rowOf('Claude Code')?.textContent).toContain('Signed in · me@example.com')
    expect(button('Continue')?.disabled).toBe(false)
  })

  it('opens Add provider from Add key', async () => {
    await mount()
    await click('Add key')
    expect(useAppStore.getState().settingsOpen).toBe(true)
    act(() => useAppStore.getState().setSettingsOpen(false))
  })

  it('opens a new thread in the picked project on Done, and does not open again', async () => {
    await mount()
    await click('Skip')
    expect(heading()).toBe('Pick a project')
    expect(button('Continue')?.disabled).toBe(true)
    await click('Choose folder')
    expect(rowOf('website')?.textContent).toContain('~/website')
    await click('Continue')
    expect(heading()).toBe('Your phone')
    await click('Done')

    expect(page()).toBeNull()
    expect(created).toHaveBeenCalledWith(undefined, 'p-site', { rememberedChoices: true })

    act(() => root.unmount())
    root = createRoot(host)
    useOnboarding.setState({ open: false })
    await mount({ projects: [], threads: [draft] })
    expect(page()).toBeNull()
  })

  it('picks the project New project adds from Clone', async () => {
    await mount()
    await click('Skip')
    await click('Clone')
    expect(useAppStore.getState().newProjectOpen).toBe(true)
    act(() => {
      useAppStore.getState().setNewProjectOpen(false)
      useAppStore.getState().setProjects([site])
    })
    await settle()
    expect(rowOf('website')).not.toBeNull()
    expect(button('Continue')?.disabled).toBe(false)
  })

  it('ends on Pick a project when this build has no Mousse ID', async () => {
    useMousseIdStore.setState({ plusLegacy: false })
    await mount()
    expect([...document.body.querySelectorAll('.wizard-step-label')].map((step) => step.textContent)).toEqual(['Connect an AI', 'Pick a project'])
    await click('Skip')
    await click('Choose folder')
    await click('Done')
    expect(page()).toBeNull()
    expect(created).toHaveBeenCalledWith(undefined, 'p-site', { rememberedChoices: true })
  })
})

describe('Your phone', () => {
  const toPhone = async () => {
    await mount()
    await click('Skip')
    await click('Skip')
    expect(heading()).toBe('Your phone')
  }

  it('signs this computer in from its own row, with the code to check', async () => {
    await toPhone()
    expect(rowOf('This computer')?.textContent).toContain('Not signed in to Mousse ID')
    expect(button('Add phone')?.disabled).toBe(true)
    await click('Sign in')
    expect(requests).toContain('net.plus.login.begin')
    expect(rowOf('Finish in your browser')?.textContent).toContain('QKMT-4821')
  })

  it('adds a phone from its own row once this computer is signed in', async () => {
    plus = signedIn
    await toPhone()
    expect(rowOf('This computer')?.textContent).toContain('Signed in · me@example.com')
    expect(rowOf('Phone')?.textContent).toContain('sign in with the same Mousse ID')
    await click('Add phone')
    expect(requests).toContain('net.plus.enrollment.offer')
    expect(document.body.querySelector('[role="dialog"] h3')?.textContent).toBe('Add a phone')
    expect(document.body.querySelector('[aria-label="Phone sign-in QR code"]')).not.toBeNull()
  })

  it('leaves the phone to sign in by itself on a computer that does not own the devices list', async () => {
    plus = signedIn
    net = { ...owningNet, self: { isAuthority: false } }
    await toPhone()
    expect(rowOf('Phone')?.textContent).toContain('sign in with the same Mousse ID')
    expect(button('Add phone')).toBeNull()
  })
})
