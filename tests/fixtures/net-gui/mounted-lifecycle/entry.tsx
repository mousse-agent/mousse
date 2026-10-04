import React from 'react'
import { createRoot } from 'react-dom/client'
import { displayBase64, displayHash, displayJson, BRIDGE_DISPLAY_CHUNK_BYTES } from '../../../../src/shared/bridge/display'
import { PrivateAsideComposer } from '../../../../src/renderer/components/chats/PrivateAsideComposer'
import { BotPermissionDecision } from '../../../../src/renderer/components/chats/BotPermissionDecision'
import { RemoteDeviceThreads } from '../../../../src/renderer/components/RemoteDeviceThreads'
import { NetworkTranscript } from '../../../../src/renderer/components/chats/NetworkTranscript'

// Controlled UI responses exercise real mounted controls. These are not signed MMS
// records, ciphertext, authentication evidence, or an executable remote thread.
const calls: Array<{ method: string; params: unknown }> = [], callbacks: unknown[] = []
const listeners = new Set<(part: unknown) => void>()
let held: ((value: unknown) => void) | undefined, rejected: ((error: Error) => void) | undefined
const root = createRoot(document.getElementById('root')!)
const node = 'nod_00000000000000000000000001', stream = 'str_00000000000000000000000001'
const network: any = { binding: { space: 'space', channel: 'channel' }, participants: [{ id: 'self', name: 'Me', kind: 'person', active: true }], records: [], readonly: false, offline: false }
const requestBody = { bot: 'bot', summary: 'Original private permission', kind: 'runtimeAction', expiresAt: Date.now() + 60000 }
const snapshot = (content: string) => ({ thread: { id: 'thread', name: 'Thread' }, messages: [{ id: 'message', role: 'assistant', content }], queue: [], pendingQuestions: [], activeTurn: { active: true } })
const position = (seq: number) => ({ ref: { nodeId: node, entityId: 'thread' }, stream, epoch: 1, seq })
;(window as any).mousse = {
  platformRequest: {
    request: (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'net.status') return Promise.resolve({ self: { user: 'self' } })
      if (method === 'chats.aside.create' || method === 'bots.grant') return new Promise((done, reject) => { held = done; rejected = reject })
      if (method === 'chats.snapshot') return Promise.resolve({ chats: [], agents: [], devices: [] })
      if (method === 'bots.list') return Promise.resolve({ bots: [{ bot: 'bot' }] })
      if (method === 'bots.presence') return Promise.resolve({ state: 'offline' })
      if (method === 'spaces.outbox') return Promise.resolve({ entries: [], total: 0 })
      if (method === 'chats.aside.get') return Promise.resolve({ private: true, records: [{ envelope: { id: 'request', type: 'bot.permission.requested', sealed: {}, author: { bot: 'bot' } }, privateBody: requestBody }], audience: { participants: ['self'] }, cursor: { epoch: 1, seq: 1 } })
      if (method === 'bridge.hub.threads') return Promise.resolve({ threads: [{ id: 'thread', name: 'Thread' }] })
      if (method === 'bridge.hub.attach' || method === 'bridge.hub.detach') return Promise.resolve({})
      return Promise.reject(new Error(method))
    }
  },
  bridge: { onThreadPart: (fn: (part: unknown) => void) => { listeners.add(fn); return () => listeners.delete(fn) } },
  files: {}, app: {}, threads: {}
}
;(window as any).qa = {
  calls, callbacks,
  publish: (part: unknown) => { for (const listener of listeners) listener(part) },
  listenerCount: () => listeners.size,
  mountRemote: (state: string) => root.render(<RemoteDeviceThreads devices={[{ node: node as any, name: 'Target', self: false, revoked: false, caps: ['read'], state }]} />),
  remoteSnapshot: () => ({ ...position(1), update: { kind: 'snapshot', value: snapshot('Retained remote body') } }),
  remoteIncremental: () => ({ ...position(2), update: { kind: 'event', type: 'turn.started', data: { threadId: 'thread' } } }),
  remoteSnapshotParts: async () => {
    const bytes = displayJson(snapshot('Fresh verified body ' + 'x'.repeat(40000)))
    const sha256 = await displayHash(bytes), transaction = crypto.randomUUID(), chunks = Math.ceil(bytes.length / BRIDGE_DISPLAY_CHUNK_BYTES)
    return [
      { ...position(3), update: { kind: 'snapshot.begin', transaction, totalBytes: bytes.length, chunks, sha256 } },
      ...Array.from({ length: chunks }, (_, index) => ({ ...position(3), update: { kind: 'snapshot.chunk', transaction, index, data: displayBase64(bytes.slice(index * BRIDGE_DISPLAY_CHUNK_BYTES, (index + 1) * BRIDGE_DISPLAY_CHUNK_BYTES)) } })),
      { ...position(3), update: { kind: 'snapshot.end', transaction, sha256 } }
    ]
  },
  mount: (mode: string) => {
    if (mode === 'aside') root.render(<PrivateAsideComposer chatId="chat" network={network} onOpen={value => callbacks.push(['open', value])} />)
    else if (mode === 'permission') root.render(<BotPermissionDecision stream={'stream' as any} request={'request' as any} body={requestBody as any} onChanged={() => callbacks.push(['change'])} />)
    else root.render(<NetworkTranscript chatId="chat" network={{ ...network, records: [{ recvTs: Date.now(), envelope: { id: 'opening', type: 'thread.opened', author: { user: 'self' }, body: { stream: 'stream', private: true, title: 'Private aside' } } }] }} />)
  },
  unmount: () => root.unmount(),
  resolve: () => held?.({ state: 'sent', stream: 'stream' }),
  reject: () => rejected?.(new Error('Original response lost')),
  text: () => document.body.innerText
}
