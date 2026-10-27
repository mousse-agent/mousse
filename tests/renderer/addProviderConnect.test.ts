// @vitest-environment jsdom
/**
 * PR 5a-2 review r1 (M2): Add provider's Connect step for a model API, mounted with Settings →
 * Providers over a fake service. Adding the entry makes the reloaded Add options say `added`; the
 * dialog keeps the chosen provider, shows why a sign-in failed or was cancelled, and Connect again
 * retries on the same entry. Cloud credentials are checked before the entry is added.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProvidersSettings } from '../../src/renderer/components/providers/ProvidersSettings'
import { LISTING_RELOAD_DELAY_MS } from '../../src/renderer/lib/providerSnapshots'
import type { InstanceSnapshot, ProviderSnapshotsEvent } from '../../src/shared/harness/status'
import type { ProviderAddOption, ProviderOperationEvent } from '../../src/shared/harness/types'
import { getDefaultSettings } from '../../src/shared/settings'
import { snapshot } from '../providerSnapshotFixture'

const option = (id: string, label: string, patch: Partial<ProviderAddOption> = {}): ProviderAddOption => ({
  id,
  label,
  methods: ['api_key'],
  add: { driver: 'pi', config: { provider: id } },
  instanceId: `pi:${id}`,
  added: false,
  hasSavedKey: false,
  ...patch
})

describe('Add provider: connecting a model API', () => {
  let host: HTMLDivElement
  let root: Root
  let entries: InstanceSnapshot[]
  let options: ProviderAddOption[]
  // The snapshot store subscribes once per module, so the listeners outlive each test's mount.
  let snapshotListeners: Array<(event: ProviderSnapshotsEvent) => void> = []
  const operationListeners: Array<(event: ProviderOperationEvent) => void> = []
  let instances: Record<string, ReturnType<typeof vi.fn>>
  let operations = 0

  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const text = () => document.body.textContent ?? ''
  const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)
  const click = async (element: Element | undefined | null) => {
    if (!element) throw new Error('nothing to click')
    await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await settle()
  }
  const choice = (label: string) => [...document.body.querySelectorAll('.prov-choice')].find((item) => item.textContent?.includes(label))
  /** Reports on the sign-in started last (ids are unique across tests: the store outlives them). */
  const emitOperation = async (patch: { phase: 'completed' } | { phase: 'cancelled' } | { phase: 'failed'; error: { code: 'signed_out'; message: string } }) => {
    const started = (await instances.signIn!.mock.results.at(-1)!.value) as { operationId: string; instanceId: string }
    const event = { operationId: started.operationId, instanceId: started.instanceId, kind: 'sign_in', ...patch } as ProviderOperationEvent
    await act(async () => { for (const listener of operationListeners) listener(event) })
    await settle()
  }
  /** The service publishes the new entry, so the reloaded options say it is added. */
  const publishAdded = async (id: string) => {
    entries = [...entries.filter((entry) => entry.instanceId !== `pi:${id}`), snapshot({ instanceId: `pi:${id}`, driver: 'pi', displayName: id, builtIn: false, auth: { state: 'signed_out' } })]
    options = options.map((entry) => (entry.id === id ? { ...entry, added: true } : entry))
    await act(async () => { for (const listener of snapshotListeners) listener({ scope: { kind: 'device' }, snapshots: entries }) })
    await act(async () => { await new Promise((done) => setTimeout(done, LISTING_RELOAD_DELAY_MS + 20)) })
    await settle()
  }
  const openAndPick = async (label: string) => {
    await click(document.body.querySelector('.prov-add-row'))
    await click(choice(label))
    await click(button('Next'))
  }

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    entries = [snapshot()]
    options = [
      option('github-copilot', 'GitHub Copilot', { methods: ['oauth'] }),
      option('amazon-bedrock', 'Amazon Bedrock', { methods: ['ambient'], ambientInfo: { label: 'Amazon Bedrock', instructions: ['Set AWS_PROFILE before starting Mousse.'] } })
    ]
    instances = {
      add: vi.fn(async (input: { config?: { provider?: string }; signIn?: string }) => {
        const id = input.config!.provider!
        if (input.signIn === 'ambient') throw new Error('Amazon Bedrock credentials were not detected in the environment.')
        return snapshot({ instanceId: `pi:${id}`, driver: 'pi', displayName: id, builtIn: false, auth: { state: 'signed_out' } })
      }),
      signIn: vi.fn(async (instanceId: string) => ({ operationId: `op-${++operations}`, instanceId, kind: 'sign_in' })),
      respondSignIn: vi.fn(async () => true),
      setEnabled: vi.fn(async (instanceId: string) => entries.find((entry) => entry.instanceId === instanceId) ?? snapshot()),
      recheck: vi.fn(async () => snapshot())
    }
    ;(window as unknown as { mousse: unknown }).mousse = {
      platform: 'linux',
      dialog: { pickExecutable: async () => null },
      providers: {
        snapshots: async () => entries,
        onSnapshots: (listener: (event: ProviderSnapshotsEvent) => void) => {
          snapshotListeners.push(listener)
          return () => { snapshotListeners = snapshotListeners.filter((entry) => entry !== listener) }
        },
        onOperation: (listener: (event: ProviderOperationEvent) => void) => {
          operationListeners.push(listener)
          return () => {}
        },
        openLoginUrl: async () => ({ ok: true }),
        catalog: { addOptions: async () => options },
        registry: { search: async () => [] },
        instances
      }
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(createElement(ProvidersSettings, {
      settings: getDefaultSettings(),
      refreshProviderData: async () => ({ opts: { themes: [], accentColors: [], llmProviders: [], agentTypes: [] } as never }),
      updateSettings: async () => {},
      ensureValidProviderSelection: async (next) => next
    })))
    await settle()
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('a failed sign-in keeps the provider and its error, and Sign in again retries on the same entry', async () => {
    await openAndPick('GitHub Copilot')
    await click(button('Sign in'))
    expect(instances.add).toHaveBeenCalledWith({ driver: 'pi', config: { provider: 'github-copilot' } })
    expect(instances.signIn).toHaveBeenCalledWith('pi:github-copilot', 'oauth')
    // The entry exists now: the options reload with it added, and the dialog stays on it.
    await publishAdded('github-copilot')
    await emitOperation({ phase: 'failed', error: { code: 'signed_out', message: 'The device code expired.' } })
    expect(text()).toContain('Provider: GitHub Copilot')
    expect(text()).toContain('The device code expired.')
    await click(button('Sign in'))
    expect(instances.add).toHaveBeenCalledTimes(2)
    expect(instances.signIn).toHaveBeenCalledTimes(2)
    await emitOperation({ phase: 'completed' })
    // Done: the dialog closes.
    expect(text()).not.toContain('Provider: GitHub Copilot')
  })

  it('a cancelled sign-in says so, with Back free and the provider still chosen', async () => {
    await openAndPick('GitHub Copilot')
    await click(button('Sign in'))
    await publishAdded('github-copilot')
    await emitOperation({ phase: 'cancelled' })
    expect(text()).toContain('Sign-in was cancelled.')
    expect(button('Back')?.disabled).toBe(false)
    expect(button('Sign in')?.disabled).toBe(false)
  })

  it('cloud credentials that are not set up add nothing and show why', async () => {
    await openAndPick('Amazon Bedrock')
    expect(text()).toContain('Set AWS_PROFILE before starting Mousse.')
    await click(button('Connect'))
    expect(instances.add).toHaveBeenCalledWith({ driver: 'pi', config: { provider: 'amazon-bedrock' }, signIn: 'ambient' })
    expect(instances.signIn).not.toHaveBeenCalled()
    expect(text()).toContain('Amazon Bedrock credentials were not detected in the environment.')
    expect(text()).toContain('Provider: Amazon Bedrock')
  })
})
