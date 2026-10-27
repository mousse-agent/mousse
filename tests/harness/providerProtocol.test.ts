import { describe, expect, it, vi } from 'vitest'
import type { HarnessGateway, HarnessInstances } from '../../src/mms/harness/gateway'
import { isInstallationMethod } from '../../src/mms/profiles/admission'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { MMS_PROTOCOL_VERSION, PROTOCOL_METHODS } from '../../src/mms/protocol/types'
import { assertGuiDaemonCompatible, GUI_REQUIRED_METHODS } from '../../src/main/mms/guiDaemonCompatibility'

const HARNESS_METHODS = PROTOCOL_METHODS.filter((method) => method === 'providers.snapshots' || method.startsWith('providers.instances.') || method.startsWith('providers.registry.'))

function context(instances?: Partial<HarnessInstances>, registry?: Partial<HarnessGateway['registry']>): HandlerContext {
  const harness = instances ? ({ instances, registry } as unknown as HarnessGateway) : undefined
  return { mms: { harness }, globalSequence: () => 0 } as unknown as HandlerContext
}

describe('harness provider protocol', () => {
  it('declares the full command set', () => {
    expect(HARNESS_METHODS).toHaveLength(18)
  })

  it('the GUI refuses, with recovery steps, a running service that predates the provider methods', async () => {
    expect(GUI_REQUIRED_METHODS.filter((method) => HARNESS_METHODS.includes(method as never))).toHaveLength(HARNESS_METHODS.length)
    const current = [...PROTOCOL_METHODS, ...GUI_REQUIRED_METHODS]
    const older = current.filter((method) => !HARNESS_METHODS.includes(method as never))
    const client = (methods: readonly string[]) => ({ request: async () => ({ protocolVersion: MMS_PROTOCOL_VERSION, methods }) }) as never
    const hello = { protocolVersion: MMS_PROTOCOL_VERSION } as never
    await expect(assertGuiDaemonCompatible(client(older), hello, '/home/me')).rejects.toThrow(/Missing APIs: providers\.snapshots, providers\.instances\.add/)
    await expect(assertGuiDaemonCompatible(client(current), hello, '/home/me')).resolves.toBeUndefined()
  })

  it('serves every method from the bound profile', () => {
    for (const method of HARNESS_METHODS) expect(isInstallationMethod(method), method).toBe(false)
  })

  it('reports not_implemented until the gateway is composed', async () => {
    await expect(dispatchMethod(context(), 'providers.snapshots', { scope: { kind: 'device' } }))
      .rejects.toMatchObject({ code: 'not_implemented' })
  })

  it('passes validated params to the gateway', async () => {
    const snapshots = vi.fn(async () => [])
    const setEnabled = vi.fn(async () => ({ instanceId: 'claude' }))
    const signIn = vi.fn(async () => ({ operationId: 'op-1', instanceId: 'claude', kind: 'sign_in' }))
    const ctx = context({ snapshots, setEnabled, signIn } as unknown as Partial<HarnessInstances>)

    expect(await dispatchMethod(ctx, 'providers.snapshots', { scope: { kind: 'project', projectId: 'p1' } }))
      .toEqual({ scope: { kind: 'project', projectId: 'p1' }, snapshots: [] })
    await dispatchMethod(ctx, 'providers.instances.setEnabled', { instanceId: 'claude', scope: { kind: 'project', projectId: 'p1' }, enabled: null })
    expect(setEnabled).toHaveBeenCalledWith('claude', { kind: 'project', projectId: 'p1' }, null)
    expect(await dispatchMethod(ctx, 'providers.instances.signIn', { instanceId: 'claude' }))
      .toEqual({ operation: { operationId: 'op-1', instanceId: 'claude', kind: 'sign_in' } })
  })

  it('refreshes the models of every instance in one call and returns each result', async () => {
    const results = [{ instanceId: 'claude', outcome: 'refreshed', snapshot: { instanceId: 'claude' } }, { instanceId: 'codex', outcome: 'skipped', message: 'Not signed in', snapshot: { instanceId: 'codex' } }]
    const refreshAllModels = vi.fn(async () => results)
    const ctx = context({ refreshAllModels } as unknown as Partial<HarnessInstances>)
    expect(await dispatchMethod(ctx, 'providers.instances.refreshAllModels', {})).toEqual({ results })
    expect(refreshAllModels).toHaveBeenCalledOnce()
  })

  it('passes registry searches, file deletions and registry sources to the gateway', async () => {
    const search = vi.fn(async () => [])
    const removeInstall = vi.fn(async () => ({ removed: true, bytes: 1 }))
    const configure = vi.fn(async () => ({ instanceId: 'acp:demo' }))
    const ctx = context({ removeInstall, configure } as unknown as Partial<HarnessInstances>, { search })
    expect(await dispatchMethod(ctx, 'providers.registry.search', { query: '  open ' })).toEqual({ agents: [] })
    expect(search).toHaveBeenCalledWith('open')
    expect(await dispatchMethod(ctx, 'providers.instances.removeInstall', { instanceId: 'acp:demo' })).toEqual({ result: { removed: true, bytes: 1 } })
    await dispatchMethod(ctx, 'providers.instances.removeInstall', { instanceId: 'acp:demo', force: true })
    expect(removeInstall).toHaveBeenLastCalledWith('acp:demo', { force: true })
    const source = { kind: 'registry', agentId: 'demo-agent', version: '1.2.3', distribution: 'binary', consent: { version: '1.2.3', artifactUrl: 'https://example.com/a.zip' } }
    await dispatchMethod(ctx, 'providers.instances.configure', { instanceId: 'acp:demo', patch: { source } })
    expect(configure).toHaveBeenCalledWith('acp:demo', { source })
    for (const bad of [
      { ...source, agentId: '../x' },
      { ...source, version: '../1' },
      { ...source, distribution: 'uvx' },
      { ...source, kind: 'local' },
      { ...source, extra: 1 },
      { ...source, consent: { version: '1.2.3' } }
    ]) await expect(dispatchMethod(ctx, 'providers.instances.configure', { instanceId: 'acp:demo', patch: { source: bad } }), JSON.stringify(bad)).rejects.toThrow()
    expect(configure).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid params before the gateway sees them', async () => {
    const setEnabled = vi.fn()
    const configure = vi.fn()
    const setModelPrefs = vi.fn()
    const ctx = context({ setEnabled, configure, setModelPrefs } as unknown as Partial<HarnessInstances>)
    await expect(dispatchMethod(ctx, 'providers.instances.setEnabled', { instanceId: 'claude', scope: { kind: 'device' }, enabled: null })).rejects.toThrow()
    await expect(dispatchMethod(ctx, 'providers.snapshots', { scope: { kind: 'galaxy' } })).rejects.toThrow()
    await expect(dispatchMethod(ctx, 'providers.instances.configure', { instanceId: 'claude', patch: { home: 'shared' } })).rejects.toThrow()
    await expect(dispatchMethod(ctx, 'providers.instances.setModelPrefs', { instanceId: 'claude', patch: { custom: [{ id: 'm', capabilities: { efforts: [] } }] } })).rejects.toThrow()
    expect(setEnabled).not.toHaveBeenCalled()
    expect(configure).not.toHaveBeenCalled()
    expect(setModelPrefs).not.toHaveBeenCalled()
  })

  it('"Use the older settings" reaches the gateway alone; any other value is refused', async () => {
    const configure = vi.fn()
    const ctx = context({ configure } as unknown as Partial<HarnessInstances>)
    await dispatchMethod(ctx, 'providers.instances.configure', { instanceId: 'claude', patch: { useOlderSettings: true, args: ['--ignored'] } })
    expect(configure).toHaveBeenCalledWith('claude', { useOlderSettings: true })
    await expect(dispatchMethod(ctx, 'providers.instances.configure', { instanceId: 'claude', patch: { useOlderSettings: false } })).rejects.toThrow()
    expect(configure).toHaveBeenCalledTimes(1)
  })
})
