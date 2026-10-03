// A layout fixture only. Actual preload/MMS qualification has a separate test.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatWorkspace } from '../../../src/renderer/components/chats/ChatWorkspace'
import { ChatsSidebar } from '../../../src/renderer/components/chats/ChatsSidebar'
import { NetDevicesSection } from '../../../src/renderer/components/NetDevicesSection'
import { useChatsStore } from '../../../src/renderer/stores/chatsStore'
import { useAppStore } from '../../../src/renderer/stores/appStore'
import '../../../src/renderer/styles/global.css'
import type { MousseAPI } from '../../../src/preload'
import type { ChatConversation, ChatsSnapshot } from '../../../src/shared/chats'

const now = Date.now(), human = 'usr_layout', bot = 'bot_layout', node = 'nod_layout'
const conversation = {
  presentation: 'network', id: 'network-layout', name: 'Project room', kind: 'group', createdAt: '', updatedAt: '', messages: [], participants: [],
  network: {
    binding: { publicationId: 'layout', space: 'spc_layout', channel: 'str_layout', owner: human, state: 'published', localHistory: { messageCount: 0 } },
    head: { epoch: 1, seq: 2 }, cursor: { epoch: 1, seq: 2 }, readonly: false, offline: false,
    participants: [{ id: human, kind: 'person', name: 'Aditi', active: true }, { id: bot, kind: 'agent', name: 'Code reader', active: true }],
    records: [{ epoch: 1, seq: 1, recvTs: now, envelope: { id: 'evt_layout', author: { user: human, node }, type: 'message.posted', body: { text: 'Please check the latest changes.' }, refs: { mentions: [bot] } } },
      { epoch: 1, seq: 2, recvTs: now, envelope: { id: 'evt_work', author: { user: human, node }, type: 'thread.opened', body: { stream: 'str_work', private: true, title: 'Review' } } }]
  }
} as unknown as ChatConversation
const snapshot = { chats: [conversation], agents: [], devices: [] } as ChatsSnapshot
window.mousse = { platformRequest: { request: async (method: string) => {
  switch (method) {
    case 'chats.snapshot': return snapshot
    case 'chats.get': return conversation
    case 'bots.presence': return { state: 'workingPrivate' }
    case 'spaces.outbox': return { entries: [{ id: 'evt_pending', state: 'unknown' }] }
    case 'net.status': return { self: { node, user: human, isAuthority: true }, enabled: true, protected: true, keystore: 'unlocked', rosterState: 'ok', peers: [], routes: [{ transport: 'cloudflared', address: 'wss://fixture.trycloudflare.com' }], transports: [{ id: 'cloudflared', enabled: true, state: 'ready', routes: [] }] }
    case 'net.transport.list': return { manifests: [{ id: 'cloudflared', displayName: 'Cloudflare Tunnel', setupSteps: [{ title: 'Quick tunnel', detail: 'Use installed cloudflared.' }] }] }
    case 'bridge.nodes': return { nodes: [{ node, name: 'This Mac', self: true, revoked: false, caps: ['read', 'write'], state: 'open' }, { node: 'nod_other', name: 'Build Mac', self: false, revoked: false, caps: ['read', 'write'], state: 'open' }] }
    default: throw new Error('This layout fixture has no daemon or mutation authority')
  }
} } } as unknown as MousseAPI
useAppStore.setState({ projects: [] })
useChatsStore.getState().activate('renderer-layout-only')
useChatsStore.setState({ snapshot, activeChatId: conversation.id, conversation })
function Preview() {
  const [devices, setDevices] = useState(false)
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <header style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 20 }}><span>Renderer layout fixture · no daemon</span><button onClick={() => setDevices(false)}>Chats</button><button onClick={() => setDevices(true)}>Devices</button></header>
    {devices ? <main style={{ padding: 28, overflow: 'auto' }}><h1>Devices</h1><NetDevicesSection /></main> : <div style={{ flex: 1, display: 'flex', minHeight: 0 }}><ChatsSidebar /><ChatWorkspace /></div>}
  </div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
