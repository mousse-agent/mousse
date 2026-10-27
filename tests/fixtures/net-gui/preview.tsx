// A layout fixture only. Actual preload/MMS qualification has a separate test.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatWorkspace } from '../../../src/renderer/components/chats/ChatWorkspace'
import { ChatsSidebar } from '../../../src/renderer/components/chats/ChatsSidebar'
import { NetDevicesSection } from '../../../src/renderer/components/NetDevicesSection'
import { AddSshDeviceDialog } from '../../../src/renderer/components/devices/AddSshDeviceDialog'
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
// `?ssh=unknown|changed|proxy|plan|running|done` picks what the remote machine dialog shows.
const sshState = new URLSearchParams(location.search).get('ssh') ?? 'unknown'
const fingerprint = `SHA256:${'q'.repeat(42)}A`
const sshCheck = () => {
  const base = { host: 'build-box', prerequisites: [] }
  if (sshState === 'proxy') return { ...base, ok: false, phase: 'untrusted', problem: 'proxy_refused', detail: 'build-box reaches the machine through ProxyJump bastion.' }
  if (sshState === 'changed') return { ...base, ok: false, phase: 'untrusted', hostKey: { type: 'ED25519', fingerprint, state: 'changed', changed: { previousFingerprint: `SHA256:${'z'.repeat(42)}B`, file: '~/.ssh/known_hosts' } } }
  if (sshState === 'plan') return { ...base, ok: true, phase: 'probed', os: 'linux', arch: 'x86_64', auth: 'ok', hostKey: { type: 'ED25519', fingerprint, state: 'trusted' }, installed: { cli: { owner: 'none' }, service: { owner: 'none' } }, prerequisites: [{ name: 'systemd user services', ok: true }, { name: 'Free disk space', ok: false, indeterminate: true }] }
  return { ...base, ok: false, phase: 'untrusted', hostKey: { type: 'ED25519', fingerprint, state: 'unknown', knownByOtherTypes: ['RSA'] } }
}
const sshSteps = [{ step: 'install', state: 'done' }, { step: 'service', state: sshState === 'done' ? 'done' : 'pending' }]
window.mousse = { platformRequest: { request: async (method: string) => {
  switch (method) {
    case 'chats.snapshot': return snapshot
    case 'chats.get': return conversation
    case 'bots.presence': return { state: 'workingPrivate' }
    case 'spaces.outbox': return { entries: [{ id: 'evt_pending', state: 'unknown' }], total: 1 }
    case 'net.status': return { self: { node, user: human, isAuthority: true }, enabled: true, features: { netBridge: true, netSpaces: true }, protected: true, keystore: 'unlocked', rosterState: 'ok', peers: [], routes: [{ transport: 'cloudflared', address: 'wss://fixture.trycloudflare.com' }], transports: [{ id: 'cloudflared', enabled: true, state: 'ready', routes: [] }] }
    case 'net.transport.list': return { manifests: [{ id: 'cloudflared', displayName: 'Cloudflare Tunnel', setupSteps: [{ title: 'Quick tunnel', detail: 'Use installed cloudflared.' }] }] }
    case 'bridge.nodes': return { nodes: [
      { node, name: 'This Mac', self: true, revoked: false, caps: ['read', 'write'], state: 'open', version: '0.1.3', platform: 'darwin', olderThanThis: false, routes: [] },
      { node: 'nod_other', name: 'Build Mac', self: false, revoked: false, caps: ['read', 'write'], state: 'open', version: '0.1.3', platform: 'darwin', route: { transport: 'tailscale', direction: 'out' }, routes: [{ route: { transport: 'tailscale', address: 'ws://100.64.0.2:4100/mousse-net', priority: 10 }, state: 'ok' }, { route: { transport: 'ssh', address: 'ssh://me@build.example.com/127.0.0.1:47821', priority: 40 }, state: 'failing', lastError: 'route_unreachable' }], olderThanThis: false },
      { node: 'nod_vps', name: 'Linux VPS', self: false, revoked: false, caps: ['read', 'chat', 'write'], state: 'closed', version: '0.1.1', platform: 'linux', arch: 'x64', lastSeenAt: now - 2 * 3600_000, routes: [], olderThanThis: true },
      { node: 'nod_legacy', name: 'Old NAS', self: false, revoked: false, caps: ['read'], state: 'closed', lastSeenAt: now - 3 * 86_400_000, routes: [], olderThanThis: true },
      { node: 'nod_box', name: 'build-box', self: false, revoked: false, caps: ['read'], state: 'open', routes: [], olderThanThis: false, sshOffer: { endpoint: 'me@build-box' } }
    ] }
    case 'net.ssh.list': return { records: [{ id: 'ssh_box', endpoint: 'me@build-box', node: 'nod_box', phase: 'done', owner: 'managed', version: '0.1.2', recoverable: false, createdAt: now, updatedAt: now }, { id: 'ssh_lab', endpoint: 'lab-server', phase: 'failed', owner: 'none', recoverable: true, createdAt: now, updatedAt: now }] }
    case 'net.ssh.check': return sshCheck()
    case 'net.ssh.plan': return { steps: [{ id: 'install', title: 'Install Mousse', detail: 'Into ~/.local/share/mousse', command: 'curl -fsSL https://example.invalid/install.sh | sh' }, { id: 'service', title: 'Start the background service', detail: 'A systemd user service' }] }
    case 'net.ssh.setup.status': return { id: 'ssh_new', phase: sshState === 'done' ? 'done' : 'running', step: 'service', progress: 'Starting the background service', recoverable: false, lingerCommand: sshState === 'done' ? 'sudo loginctl enable-linger me' : undefined, steps: sshSteps }
    default: throw new Error('This layout fixture has no daemon or mutation authority')
  }
} } } as unknown as MousseAPI
useAppStore.setState({ projects: [] })
useChatsStore.getState().activate('renderer-layout-only')
useChatsStore.setState({ snapshot, activeChatId: conversation.id, conversation })
function Preview() {
  const [devices, setDevices] = useState(false), [ssh, setSsh] = useState(false)
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <header style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 20 }}><span>Renderer layout fixture · no daemon</span><button onClick={() => setDevices(false)}>Chats</button><button onClick={() => setDevices(true)}>Devices</button><button onClick={() => { setDevices(true); setSsh(true) }}>Remote machine ({sshState})</button></header>
    {devices ? <main style={{ padding: 28, overflow: 'auto' }}><h1>Devices</h1><NetDevicesSection />{ssh && <AddSshDeviceDialog open setupId={sshState === 'running' || sshState === 'done' ? 'ssh_new' : undefined} onClose={() => setSsh(false)} onDone={() => undefined} />}</main> : <div style={{ flex: 1, display: 'flex', minHeight: 0 }}><ChatsSidebar /><ChatWorkspace /></div>}
  </div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
