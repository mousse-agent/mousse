import React from 'react'
import { createRoot } from 'react-dom/client'
import { PrivateAsideComposer } from '../../../../src/renderer/components/chats/PrivateAsideComposer'
import { BotPermissionDecision } from '../../../../src/renderer/components/chats/BotPermissionDecision'
import { NetworkTranscript } from '../../../../src/renderer/components/chats/NetworkTranscript'

// Controlled UI responses exercise real mounted controls. These are not signed MMS
// records, ciphertext or authentication evidence.
const calls: Array<{ method: string; params: unknown }> = [], callbacks: unknown[] = []
let held: ((value: unknown) => void) | undefined, rejected: ((error: Error) => void) | undefined
const root = createRoot(document.getElementById('root')!)
const network: any = { binding: { space: 'space', channel: 'channel' }, participants: [{ id: 'self', name: 'Me', kind: 'person', active: true }], records: [], readonly: false, offline: false }
const requestBody = { bot: 'bot', summary: 'Original private permission', kind: 'runtimeAction', expiresAt: Date.now() + 60000 }
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
      return Promise.reject(new Error(method))
    }
  },
  files: {}, app: {}, threads: {}
}
;(window as any).qa = {
  calls, callbacks,
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
