import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { ControlStore } from '../src/mms/control/storage/controlStore'
import { ChannelStore } from '../src/mms/channels/ChannelStore'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { isInstallationMethod } from '../src/mms/profiles/admission'

const fixtures: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const fixture of fixtures.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(fixture))
    if (isAbsolute(rel) || !rel.startsWith('mousse-profile-connections-') || rel.startsWith('..')) throw new Error('Unsafe fixture cleanup')
    rmSync(fixture, { recursive: true, force: true })
  }
})

describe('profile-owned channels and connections', () => {
  it('keeps persisted channel tokens, account credentials, devices and connection preferences separate', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-profile-connections-'))
    fixtures.push(root)
    const a = join(root, 'a'), b = join(root, 'b')
    const installation = MousseConfigStore.loadInstallation(join(root, 'installation'))
    const channelsA = new ChannelStore(MousseConfigStore.loadProfile(a, installation), { inheritEnvironment: false })
    const channelsB = new ChannelStore(MousseConfigStore.loadProfile(b, installation), { inheritEnvironment: false })
    const controlA = new ControlStore(a), controlB = new ControlStore(b)
    vi.stubEnv('MOUSSE_HOME', b)
    const channels = channelsA.getConfig()
    channels.platforms.telegram.token = 'profile-a-token'
    channels.platforms.telegram.enabled = true
    channelsA.updateConfig(channels)
    controlA.saveCredentials({ accountId: 'account-a', accessToken: 'private-a', updatedAt: new Date().toISOString() })
    controlA.saveConfig({ mode: 'self-hosted', controlOrigin: 'https://control-a.example' })
    controlA.savePairing({ pairingId: 'a-phone', mobileDeviceId: 'phone-a', mobileStaticPublicKey: 'key-a', grantedScopes: [], createdAt: new Date().toISOString(), status: 'active', receiptSignature: 'signature-a' })

    expect(channelsB.getConfig().platforms.telegram.token).toBeUndefined()
    expect(channelsB.getConfig().platforms.telegram.enabled).toBe(false)
    expect(controlB.getCredentials()).toBeNull()
    expect(controlB.listPairings()).toEqual([])
    expect(controlB.getConfig().mode).toBe('hosted')
    expect(controlB.revokePairing('a-phone')).toBeNull()
    expect(controlB.getDeviceIdentity().mmsDeviceId).not.toBe(controlA.getDeviceIdentity().mmsDeviceId)

    const reopenedA = new ControlStore(a)
    expect(reopenedA.getCredentials()?.accessToken).toBe('private-a')
    expect(reopenedA.getPairing('a-phone')?.status).toBe('active')
    expect(reopenedA.getConfig().controlOrigin).toBe('https://control-a.example')
    expect(new ChannelStore(MousseConfigStore.loadProfile(a, installation), { inheritEnvironment: false }).getConfig().platforms.telegram.token).toBe('profile-a-token')
  })

  it('requires profile admission for channel and connection operations', () => {
    for (const method of ['channels.getConfig', 'channels.updateConfig', 'channels.connect', 'channels.getActivity', 'control.status', 'control.login', 'control.enroll', 'control.disconnect', 'pairing.list', 'pairing.approve', 'pairing.revoke']) {
      expect(isInstallationMethod(method), method).toBe(false)
    }
    expect(isInstallationMethod('providers.list')).toBe(true)
  })
})
