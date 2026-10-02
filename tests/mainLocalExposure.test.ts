import { describe, expect, it, vi } from 'vitest'
import { openExternalSafely, toSafeExternalUrl } from '../src/main/safeExternalUrl'
import { approvePairingWithConfirmation } from '../src/main/pairingApproval'
import type { ControlStatus, RemoteScope } from '../src/shared/controlTypes'

describe('toSafeExternalUrl', () => {
  it.each([
    ['https://mousse.plus', 'https://mousse.plus/'],
    ['http://127.0.0.1:3000/a?b=1', 'http://127.0.0.1:3000/a?b=1'],
    ['  https://example.com/x  ', 'https://example.com/x']
  ])('allows %s', (input, expected) => {
    expect(toSafeExternalUrl(input)).toBe(expected)
  })

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'ms-msdt:/id',
    'mousse://pair?x=1',
    'data:text/html,hi',
    'not a url',
    '',
    undefined,
    42
  ])('rejects %s', (input) => {
    expect(toSafeExternalUrl(input)).toBeNull()
  })
})

describe('openExternalSafely', () => {
  it('opens http(s) and denies others without throwing', async () => {
    const open = vi.fn(async () => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await openExternalSafely(open, 'https://example.com', 't')).toBe(true)
    expect(await openExternalSafely(open, 'file:///etc/passwd', 't')).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('swallows open failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const open = vi.fn(async () => {
      throw new Error('boom')
    })
    expect(await openExternalSafely(open, 'https://example.com', 't')).toBe(false)
    warn.mockRestore()
  })
})

function status(requested: RemoteScope[], state: 'claimed' | 'pending' = 'claimed'): ControlStatus {
  return {
    pendingPairing: {
      pairingId: 'p1',
      expiresAt: Date.now() + 1000,
      qrUri: 'x',
      state,
      claimedBy:
        state === 'claimed'
          ? { mobileDeviceId: 'dev-1', mobileDeviceName: 'Pixel', fingerprint: 'ab:cd', requestedScopes: requested }
          : undefined
    }
  } as unknown as ControlStatus
}

function setup(
  response: number,
  requested: RemoteScope[] = ['mousse:read', 'mousse:chat'],
  state: 'claimed' | 'pending' = 'claimed'
) {
  const pairingApprove = vi.fn(async () => ({ grant: {}, receipt: 'r', receiptSignature: 's' }) as never)
  const showMessageBox = vi.fn(async (..._args: unknown[]) => ({ response, checkboxChecked: false }))
  const deps = {
    controlStatus: async () => status(requested, state),
    pairingApprove,
    showMessageBox: showMessageBox as never,
    window: null
  }
  return { deps, pairingApprove, showMessageBox }
}

describe('approvePairingWithConfirmation', () => {
  it('approves through the daemon after the user clicks Approve', async () => {
    const { deps, pairingApprove, showMessageBox } = setup(0)
    await approvePairingWithConfirmation(deps, 'p1', ['mousse:read'])
    expect(pairingApprove).toHaveBeenCalledWith('p1', ['mousse:read'])
    const options = showMessageBox.mock.calls[0][1] as { buttons: string[]; defaultId: number; detail: string }
    expect(options.buttons).toEqual(['Approve', 'Cancel'])
    expect(options.defaultId).toBe(1)
    expect(options.detail).toContain('Pixel')
    expect(options.detail).toContain('dev-1')
    expect(options.detail).toContain('Read projects')
  })

  it('defaults to the requested scopes', async () => {
    const { deps, pairingApprove } = setup(0)
    await approvePairingWithConfirmation(deps, 'p1')
    expect(pairingApprove).toHaveBeenCalledWith('p1', ['mousse:read', 'mousse:chat'])
  })

  it('does not approve when the user cancels', async () => {
    const { deps, pairingApprove } = setup(1)
    await expect(approvePairingWithConfirmation(deps, 'p1', ['mousse:read'])).rejects.toThrow(/cancelled/)
    expect(pairingApprove).not.toHaveBeenCalled()
  })

  it('refuses scopes beyond the pending request without prompting', async () => {
    const { deps, pairingApprove, showMessageBox } = setup(0)
    await expect(
      approvePairingWithConfirmation(deps, 'p1', ['mousse:read', 'mousse:terminal'])
    ).rejects.toThrow(/exceed/)
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(pairingApprove).not.toHaveBeenCalled()
  })

  it('refuses unknown or unclaimed pairings', async () => {
    const wrongId = setup(0)
    await expect(approvePairingWithConfirmation(wrongId.deps, 'other')).rejects.toThrow(/No pending/)
    const unclaimed = setup(0, [], 'pending')
    await expect(approvePairingWithConfirmation(unclaimed.deps, 'p1')).rejects.toThrow(/No pending/)
    expect(wrongId.pairingApprove).not.toHaveBeenCalled()
    expect(unclaimed.pairingApprove).not.toHaveBeenCalled()
  })
})
