import { describe, expect, it } from 'vitest'
import { botNotificationKind, planThreadNotification } from '../src/main/notifications/threadNotification'
import { threadNotificationChannelPatch, threadNotificationChannels, type NotificationChannels } from '../src/shared/settings'

const all: NotificationChannels = { toast: true, system: true, sound: true }

describe('thread notification channels', () => {
  it('turns every channel on for an event not chosen yet, and takes the old sound switch for its sound', () => {
    expect(threadNotificationChannels({ threadCompletionSound: true, allRemoteThreads: false }, 'completed')).toEqual(all)
    expect(threadNotificationChannels({ threadCompletionSound: false, allRemoteThreads: false }, 'question')).toEqual({ toast: true, system: true, sound: false })
  })

  it('keeps what was chosen per event and channel', () => {
    const settings = { threadCompletionSound: true, allRemoteThreads: false, events: { idle: { system: false } } }
    expect(threadNotificationChannels(settings, 'idle')).toEqual({ toast: true, system: false, sound: true })
    expect(threadNotificationChannels(settings, 'completed')).toEqual(all)
  })

  it('patches one channel of one event only, so two quick changes merge instead of overwriting', () => {
    expect(threadNotificationChannelPatch('question', 'sound', false)).toEqual({ notifications: { events: { question: { sound: false } } } })
  })
})

describe('how a thread event reaches the person', () => {
  it('plays only the sound for the thread on screen in a focused window', () => {
    expect(planThreadNotification(all, { windowFocused: true, viewingThread: true, systemSupported: true }))
      .toEqual({ toast: false, system: false, playSound: true })
  })

  it('shows a toast, not a system notification, for another thread while Mousse is in front', () => {
    expect(planThreadNotification(all, { windowFocused: true, viewingThread: false, systemSupported: true }))
      .toEqual({ toast: true, system: false, playSound: true })
  })

  it('shows both while Mousse is in the background, and the system notification carries the sound', () => {
    expect(planThreadNotification(all, { windowFocused: false, viewingThread: false, systemSupported: true }))
      .toEqual({ toast: true, system: true, playSound: false })
  })

  it('falls back to the system notification in front when toasts are off for the event', () => {
    expect(planThreadNotification({ ...all, toast: false }, { windowFocused: true, viewingThread: false, systemSupported: true }))
      .toEqual({ toast: false, system: true, playSound: false })
  })

  it('does nothing for an event with every channel off', () => {
    expect(planThreadNotification({ toast: false, system: false, sound: false }, { windowFocused: false, viewingThread: false, systemSupported: true }))
      .toEqual({ toast: false, system: false, playSound: false })
  })

  it('plays the sound itself where the system cannot show notifications', () => {
    expect(planThreadNotification(all, { windowFocused: false, viewingThread: false, systemSupported: false }))
      .toEqual({ toast: true, system: false, playSound: true })
  })
})

describe('a bot row on the same channels', () => {
  const at = new Date().toISOString()
  it('uses the completed choices for a report and the question choices for an ask, as threads do', () => {
    const settings = { threadCompletionSound: true, allRemoteThreads: false, events: { question: { system: false } } }
    const report = botNotificationKind({ author: 'bot', at })!
    const ask = botNotificationKind({ author: 'bot', at, ask: { askId: 'k1', title: 'read files in ~/Notes', note: '', status: 'open' } })!
    expect([report, ask]).toEqual(['completed', 'question'])
    expect(threadNotificationChannels(settings, report)).toEqual(all)
    expect(threadNotificationChannels(settings, ask)).toEqual({ toast: true, system: false, sound: true })
  })
})
