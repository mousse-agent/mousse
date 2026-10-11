import { expect, it } from 'vitest'
import { remoteDisplay } from '../../src/renderer/services/remoteThreadDisplay'
import type { BridgeDisplayEvent } from '../../src/shared/bridge'
const ref = { nodeId: 'nod_fixture', entityId: 'remote-thread' }
const row = (id: string, content: string) => ({ id, content, role: 'assistant', timestamp: '2026-10-03' })
const event = (type: string, data: unknown): BridgeDisplayEvent => ({ ref, stream: 'str_fixture', epoch: 1, seq: 2, update: { kind: 'event', type, data } }) as BridgeDisplayEvent
const snapshot = (messages = [row('original', 'original content')]): BridgeDisplayEvent => ({ ref, stream: 'str_fixture', epoch: 1, seq: 1, update: { kind: 'snapshot', value: { thread: { id: ref.entityId, name: 'Original remote' }, messages, queue: [], pendingQuestions: [], activeTurn: { active: false, running: false } } } }) as BridgeDisplayEvent

it('keeps originals isolated while projecting actual message, metadata and turn updates', () => {
  const original = snapshot(), bytes = JSON.stringify(original)
  const held = remoteDisplay(undefined, original)!
  const updated = remoteDisplay(held, event('thread.message-updated', { threadId: ref.entityId, message: row('original', 'updated content') }))!
  const renamed = remoteDisplay(updated, event('thread.metadata', { thread: { id: ref.entityId, name: 'Verified rename' } }))!
  const running = remoteDisplay(renamed, event('turn.started', { threadId: ref.entityId }))!
  expect(running.messages).toHaveLength(1)
  expect(running.messages[0].content).toBe('updated content')
  expect(running.thread.name).toBe('Verified rename')
  expect(running.active).toBe(true)
  expect(remoteDisplay(running, event('turn.completed', { threadId: ref.entityId }))!.active).toBe(false)
  expect(held.messages[0].content).toBe('original content')
  expect(JSON.stringify(original)).toBe(bytes)
})

it('does not expose partial updates before a complete snapshot and rejects foreign thread payloads', () => {
  expect(remoteDisplay(undefined, event('thread.message', { threadId: ref.entityId, message: row('first', 'partial') }))).toBeUndefined()
  const held = remoteDisplay(undefined, snapshot())!
  expect(() => remoteDisplay(held, event('thread.message', { threadId: 'other', message: row('first', 'foreign') }))).toThrow('Remote thread mismatch')
  expect(() => remoteDisplay(held, event('thread.metadata', { thread: { id: 'other', name: 'Other' } }))).toThrow('Invalid remote metadata')
  expect(() => remoteDisplay(undefined, { ...snapshot(), update: { kind: 'snapshot', value: { thread: { id: 'other' } } } })).toThrow('Invalid remote thread view')
})

it('bounds the display and honors the actual replacement flag without rewriting prior views', () => {
  const held = remoteDisplay(undefined, snapshot(Array.from({ length: 2100 }, (_, index) => row(String(index), 'content'))))!
  expect(held.messages).toHaveLength(2048)
  const replaced = remoteDisplay(held, event('thread.messages', { threadId: ref.entityId, messages: [row('replacement', 'new')], replace: true }))!
  expect(replaced.messages.map(message => message.id)).toEqual(['replacement'])
  expect(held.messages).toHaveLength(2048)
})
