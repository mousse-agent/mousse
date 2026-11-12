import { useState } from 'react'
import { PROFILER_TOOL_LABELS, PROFILER_TOOL_NAMES, type ProfilerSettings } from '../../../shared/diagnostics/profiler'
import type { MousseSettings, MousseSettingsUpdate } from '../../../shared/settings'
import { Cpu } from '../../lib/icons'
import { showToast } from '../ui/Toast'
import { MemoryRows } from './MemoryRows'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'

/** What a heap snapshot holds, said before one is written. */
export const HEAP_SNAPSHOT_WARNING = 'Holds thread text, prompts, paths and tokens. Stays on this computer; never share it.'

/**
 * Settings → Labs. The profiler: one switch, off by default; everything else shows only while it is on. Agent
 * access and each tool's switch show under it, the tools only while agent access is on.
 */
export function LabsSettings({ settings, onUpdate }: { settings: MousseSettings; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const profiler = settings.experimental.profiler
  const set = (next: Partial<ProfilerSettings>) =>
    onUpdate({ experimental: { ...settings.experimental, profiler: { ...profiler, ...next, tools: { ...profiler.tools, ...next.tools } } } })
  return (
    <section id="labs" className="settings-section">
      <SettingsGroup title="Profiler" icon={Cpu}>
        <SettingsRow
          title="Profiler"
          anchor="labs-profiler"
          htmlFor="labs-profiler"
          description={<span title="Samples every Mousse process about once a minute and keeps a local log of numbers only. Off: nothing samples, logs or shows.">Memory and CPU of every Mousse process.</span>}
          control={<Switch id="labs-profiler" label="Profiler" checked={profiler.enabled} onChange={(enabled) => void set({ enabled })} />}
        />
        {profiler.enabled && (
          <ProfilerRows
            profiler={profiler}
            set={set}
            notices={settings.notifications.memoryNotices !== false}
            setNotices={(memoryNotices) => onUpdate({ notifications: { ...settings.notifications, memoryNotices } })}
          />
        )}
      </SettingsGroup>
    </section>
  )
}

function ProfilerRows({ profiler, set, notices, setNotices }: {
  profiler: ProfilerSettings
  set: (next: Partial<ProfilerSettings>) => Promise<void>
  notices: boolean
  setNotices: (on: boolean) => Promise<void>
}) {
  return (
    <>
      <MemoryRows />
      <SettingsRow
        title="Memory notices"
        anchor="labs-memory-notices"
        htmlFor="labs-memory-notices"
        indent
        description={<span title="At most once a day, with Report. The numbers are logged either way.">When memory goes out of bounds.</span>}
        control={<Switch id="labs-memory-notices" label="Memory notices" checked={notices} onChange={(on) => void setNotices(on)} />}
      />
      <HeapSnapshotRow />
      <SettingsRow
        title="Agents can read the profiler"
        anchor="labs-profiler-agents"
        htmlFor="labs-profiler-agents"
        indent
        description={<span title="Agents in Mousse threads can call the profiler tools turned on below. They return numbers only; thread titles only for this profile's threads.">Numbers only, through the tools below.</span>}
        control={<Switch id="labs-profiler-agents" label="Agents can read the profiler"checked={profiler.agentAccess} onChange={(agentAccess) => void set({ agentAccess })} />}
      />
      {profiler.agentAccess && PROFILER_TOOL_NAMES.map((name) => (
        <SettingsRow
          key={name}
          title={<span title={PROFILER_TOOL_LABELS[name].detail}>{PROFILER_TOOL_LABELS[name].label}</span>}
          htmlFor={`labs-tool-${name}`}
          indent
          className="indent-2"
          description={<code className="settings-tool-name">{name}</code>}
          control={
            <Switch
              id={`labs-tool-${name}`}
              label={PROFILER_TOOL_LABELS[name].label}
              checked={profiler.tools[name]}
              onChange={(on) => void set({ tools: { ...profiler.tools, [name]: on } })}
            />
          }
        />
      ))}
    </>
  )
}

/** Writes a service heap snapshot after a second click that names what it holds. */
function HeapSnapshotRow() {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const write = async () => {
    setBusy(true)
    try {
      const written = await window.mousse.diagnostics.heapSnapshot()
      showToast({ key: 'heap-snapshot', message: `Heap snapshot written (${Math.round(written.mb)} MB)`, detail: `<Mousse home>/${written.file}` })
    } catch (error) {
      showToast({ key: 'heap-snapshot', tone: 'error', message: "Couldn't write the heap snapshot.", detail: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }
  return (
    <SettingsRow
      title="Heap snapshot"
      anchor="labs-heap-snapshot"
      indent
      description={<span className="settings-status-warn" title={`${HEAP_SNAPSHOT_WARNING} Writing one pauses Mousse for a few seconds. Refused while a turn runs.`}>{HEAP_SNAPSHOT_WARNING}</span>}
      control={confirming ? (
        <span className="memory-row-controls">
          <button type="button" className="settings-btn" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          <button type="button" className="settings-btn" disabled={busy} onClick={() => void write()}>{busy ? 'Writing…' : 'Write anyway'}</button>
        </span>
      ) : (
        <button type="button" className="settings-btn" onClick={() => setConfirming(true)}>Write…</button>
      )}
    />
  )
}
