import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { chunkMessage } from '../src/mms/channels/chunkMessage'
import { isSilenceNarration, parseDeliveryTarget } from '../src/mms/channels/delivery'
import { ChannelStore } from '../src/mms/channels/ChannelStore'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { buildSessionKey } from '../src/mms/channels/types'

describe('buildSessionKey', () => {
  it('builds stable session keys', () => {
    expect(buildSessionKey('telegram', '12345')).toBe('telegram:12345')
    expect(buildSessionKey('discord', '987', '555')).toBe('discord:987:555')
  })
})

describe('delivery', () => {
  it('parses explicit targets', () => {
    const target = parseDeliveryTarget('telegram:12345:99')
    expect(target.platform).toBe('telegram')
    expect(target.chatId).toBe('12345')
    expect(target.threadId).toBe('99')
  })

  it('detects silence narration', () => {
    expect(isSilenceNarration('*(silent)*')).toBe(true)
    expect(isSilenceNarration('The deployment ran silently')).toBe(false)
  })
})

describe('chunkMessage', () => {
  it('splits long messages', () => {
    const text = 'word '.repeat(900).trim()
    const chunks = chunkMessage(text, 500)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join(' ')).toContain('word')
  })
})

describe('ChannelStore', () => {
  it('persists config and sessions', () => {
    const originalHome = process.env.MOUSSE_HOME
    const tempHome = mkdtempSync(join(tmpdir(), 'mousse-channels-test-'))
    process.env.MOUSSE_HOME = tempHome

    try {
      const configStore = MousseConfigStore.load(tempHome)
      const store = new ChannelStore(configStore)
      const updated = store.updateConfig({
        platforms: {
          telegram: { enabled: true, token: 'test-token', allowedUserIds: ['1'] },
          discord: { enabled: false },
          webhook: { enabled: false }
        }
      })
      expect(updated.platforms.telegram.enabled).toBe(true)

      store.upsertSession({
        sessionKey: 'telegram:1',
        platform: 'telegram',
        chatId: '1',
        chatType: 'dm',
        mousseThreadId: 'thread-1',
        createdAt: new Date().toISOString()
      })
      expect(store.listSessions()).toHaveLength(1)
    } finally {
      if (originalHome === undefined) {
        delete process.env.MOUSSE_HOME
      } else {
        process.env.MOUSSE_HOME = originalHome
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })
})
