import { describe, expect, it, vi } from 'vitest'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'

type Status = { state: string; checkedAt?: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function setup(initial: { claude: Status; codex: Status }) {
  let providers = [{ id: 'codex' }]
  const claudeStatus = vi.fn(async (): Promise<Status> => initial.claude)
  const codexStatus = vi.fn(async (): Promise<Status> => initial.codex)
  const emitEvent = vi.fn()
  const context = {
    mms: {
      claudeSubscription: { status: claudeStatus },
      codex: { status: codexStatus },
      providerInstances: { configuredProviders: () => providers, storeError: () => undefined }
    },
    globalSequence: () => 0,
    emitEvent
  } as unknown as HandlerContext
  return { context, claudeStatus, codexStatus, emitEvent, setProviders: (next: typeof providers) => { providers = next } }
}

const checked = { state: 'connected', checkedAt: '2026-10-22T00:00:00.000Z' }

describe('vendor sign-in checks on provider reads', () => {
  it('waits for the first check, then answers from the cached result while a refresh runs', async () => {
    const { context, codexStatus, emitEvent, setProviders } = setup({ claude: checked, codex: checked })
    await dispatchMethod(context, 'providers.listConfigured', {})
    expect(codexStatus).toHaveBeenCalledTimes(1)

    const slow = deferred<Status>()
    codexStatus.mockImplementationOnce(() => slow.promise)
    const result = await dispatchMethod(context, 'providers.listConfigured', {}) as { providers: unknown[] }
    expect(result.providers).toEqual([{ id: 'codex' }])
    expect(codexStatus).toHaveBeenCalledTimes(2)
    expect(emitEvent).not.toHaveBeenCalled()

    setProviders([])
    slow.resolve({ state: 'signed_out', checkedAt: '2026-10-22T00:05:00.000Z' })
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledWith('providers.changed', { providers: [] }))
  })

  it('keeps waiting while a sign-in has never been checked', async () => {
    const { context, claudeStatus } = setup({ claude: { state: 'error' }, codex: checked })
    await dispatchMethod(context, 'providers.listConfigured', {})

    const slow = deferred<Status>()
    claudeStatus.mockImplementationOnce(() => slow.promise)
    let settled = false
    const pending = dispatchMethod(context, 'providers.listConfigured', {}).then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    slow.resolve(checked)
    await pending
    expect(settled).toBe(true)
  })

  it('does not announce a refresh that leaves the provider list unchanged', async () => {
    const { context, codexStatus, emitEvent } = setup({ claude: checked, codex: checked })
    await dispatchMethod(context, 'providers.listConfigured', {})
    await dispatchMethod(context, 'providers.listConfigured', {})
    await vi.waitFor(() => expect(codexStatus).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 10))
    expect(emitEvent).not.toHaveBeenCalled()
  })
})
