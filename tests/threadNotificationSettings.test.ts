import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getThreadNotificationPresentation } from '../src/main/notifications/threadNotification'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { getDefaultSettings } from '../src/shared/settings'

describe('thread completion notification sound', () => {
  let originalHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    originalHome = process.env.MOUSSE_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'mousse-notification-settings-'))
    process.env.MOUSSE_HOME = tempHome
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.MOUSSE_HOME
    } else {
      process.env.MOUSSE_HOME = originalHome
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('defaults on and persists changes in mousse.conf', () => {
    const settings = new SettingsStore(MousseConfigStore.load(tempHome))
    expect(settings.get().notifications.threadCompletionSound).toBe(true)

    settings.set({ notifications: { threadCompletionSound: false } })

    const reloaded = new SettingsStore(MousseConfigStore.load(tempHome))
    expect(reloaded.get().notifications.threadCompletionSound).toBe(false)
  })

  it('uses the OS sound only for enabled completion notifications', () => {
    const enabled = getDefaultSettings()
    expect(getThreadNotificationPresentation('completed', enabled)).toEqual({
      body: 'Agent finished',
      silent: false,
      sound: 'Ping'
    })

    const disabled = {
      ...enabled,
      notifications: { threadCompletionSound: false }
    }
    expect(getThreadNotificationPresentation('completed', disabled).silent).toBe(true)
    expect(getThreadNotificationPresentation('completed', disabled).sound).toBeUndefined()
    expect(getThreadNotificationPresentation('question', enabled).silent).toBe(true)
    expect(getThreadNotificationPresentation('question', enabled).sound).toBeUndefined()
  })
})
