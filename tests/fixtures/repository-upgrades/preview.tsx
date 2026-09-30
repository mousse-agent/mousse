import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatComposer, type VoiceMessage } from '../../../src/renderer/components/ChatComposer'
import { StorageSettings } from '../../../src/renderer/components/StorageSettings'
import type { TaskLifecycleRecord } from '../../../src/shared/resourceLifecycle'

type MediaMode = 'denied' | 'missing' | 'capture' | 'pending' | 'success'
const probes = {
  mediaMode: 'denied' as MediaMode, mediaRequests: 0, stoppedTracks: 0, recordings: 0,
  recorderStops: 0, inventoryCalls: 0, inventoryActive: 0, inventoryMaxActive: 0,
  activeIntervals: 0,
  inventoryDelay: 0, savedGraceDays: 30, state: 'active', resolveMedia: undefined as (() => void) | undefined,
  failRecorder: undefined as (() => void) | undefined
}
Object.assign(window, { upgradeProbes: probes })
const intervals = new Set<number>()
const setIntervalOriginal = window.setInterval.bind(window)
const clearIntervalOriginal = window.clearInterval.bind(window)
window.setInterval = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
  const id = setIntervalOriginal(callback, timeout, ...args)
  intervals.add(id); probes.activeIntervals = intervals.size
  return id
}) as typeof window.setInterval
window.clearInterval = ((id?: number) => {
  if (id !== undefined) intervals.delete(id)
  probes.activeIntervals = intervals.size
  clearIntervalOriginal(id)
}) as typeof window.clearInterval
function stream(): MediaStream {
  return { getTracks: () => [{ stop: () => { probes.stoppedTracks += 1 } }] } as unknown as MediaStream
}
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
  getUserMedia: async () => {
    probes.mediaRequests += 1
    if (probes.mediaMode === 'denied') throw new DOMException('fixture private path', 'NotAllowedError')
    if (probes.mediaMode === 'missing') throw new DOMException('fixture device details', 'NotFoundError')
    if (probes.mediaMode === 'pending') await new Promise<void>((resolve) => { probes.resolveMedia = resolve })
    return stream()
  }
} })
class FixtureRecorder {
  state = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable?: (event: { data: Blob }) => void
  onstop?: () => void
  onerror?: (event: { error: DOMException }) => void
  constructor(public stream: MediaStream) {
    if (probes.mediaMode === 'capture') throw new DOMException('fixture codec internals', 'NotSupportedError')
    probes.failRecorder = () => this.onerror?.({ error: new DOMException('fixture failure', 'NotReadableError') })
  }
  start() { this.state = 'recording'; probes.recordings += 1 }
  stop() {
    this.state = 'inactive'; probes.recorderStops += 1
    this.ondataavailable?.({ data: new Blob(['fixture audio'], { type: this.mimeType }) })
    this.onstop?.()
  }
  static isTypeSupported() { return true }
}
Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FixtureRecorder })

function record(): TaskLifecycleRecord {
  return {
    schemaVersion: 1, minimumWriterVersion: 1, profileId: 'fixture-profile', taskId: 'fixture-task',
    generation: 1, state: probes.state as TaskLifecycleRecord['state'], originalLocation: '/fixture/task',
    location: '/fixture/task', locations: ['/fixture/task'], operations: [],
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    ...(probes.state === 'trashed' ? { trashedAt: '2026-09-15T00:00:00.000Z', blockedReason: 'Fixture unpublished result requires review' } : {})
  }
}
Object.assign(window, { mousse: { threads: {
  inventory: async () => {
    probes.inventoryCalls += 1; probes.inventoryActive += 1
    probes.inventoryMaxActive = Math.max(probes.inventoryMaxActive, probes.inventoryActive)
    try {
      if (probes.inventoryDelay) await new Promise((resolve) => setTimeout(resolve, probes.inventoryDelay))
      return { lifecycles: [record()], taskNames: { 'fixture-task': 'Fixture task' },
        trashPolicy: { schemaVersion: 1, graceDays: probes.savedGraceDays, automaticPurge: false },
        trashSweepStatus: { reason: 'Fixture cleanup status' } }
    } finally { probes.inventoryActive -= 1 }
  },
  configureTrash: async (policy: { graceDays: number }) => { probes.savedGraceDays = policy.graceDays },
  delete: async () => { probes.state = 'trashed' }, restore: async () => { probes.state = 'active' }
} } })

function Fixture() {
  const [view, setView] = useState<'voice' | 'storage' | 'none'>('voice')
  const [input, setInput] = useState('')
  const [voices, setVoices] = useState<VoiceMessage[]>([])
  return <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
    <nav style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
      <button onClick={() => setView('voice')}>Show voice</button>
      <button onClick={() => setView('storage')}>Show storage</button>
      <button onClick={() => setView('none')}>Unmount components</button>
    </nav>
    {view === 'voice' && <ChatComposer input={input} onInputChange={setInput} attachedFiles={[]}
      onAttachedFilesChange={() => {}} voiceMessages={voices} onVoiceMessagesChange={setVoices}
      chatMode="agent" onChatModeChange={() => {}} enabledSkills={[]} providers={[]}
      selectedProviderId="" selectedModelId="" modelMenuOpen={false} onModelMenuOpenChange={() => {}}
      onModelSelect={() => {}} onOpenSettings={() => {}} contextOpen={false} onContextOpenChange={() => {}}
      contextUsage={{ percent: 0, used: 0, limit: 100, modelName: null, source: 'estimated', categories: [] }}
      onSend={() => {}} hideModePicker />}
    {view === 'storage' && <StorageSettings />}
    <output data-voice-count>{voices.length} voice attachments</output>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
