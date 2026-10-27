import { useMemo } from 'react'
import { Laptop, X } from '../lib/icons'
import { closeRemoteThread, selectRemoteThread, useRemoteThreads, type RemoteThreadEntry } from '../lib/remoteThreadStore'
import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import './remoteThread.css'

/** Groups the attached remote threads by the computer they run on, in attachment order. */
export function groupByDevice(entries: readonly RemoteThreadEntry[]): Array<{ node: string; name: string; threads: RemoteThreadEntry[] }> {
  const groups = new Map<string, { node: string; name: string; threads: RemoteThreadEntry[] }>()
  for (const entry of entries) {
    const group = groups.get(entry.ref.nodeId) ?? { node: entry.ref.nodeId, name: entry.deviceName ?? 'Another computer', threads: [] }
    if (entry.deviceName) group.name = entry.deviceName
    group.threads.push(entry)
    groups.set(entry.ref.nodeId, group)
  }
  return [...groups.values()]
}

/**
 * Threads of this window that run on other computers, under one heading per computer. Only
 * threads this window is attached to appear; closing a row detaches it.
 */
export function RemoteAttachedThreads() {
  const entries = useRemoteThreads((state) => state.entries)
  const order = useRemoteThreads((state) => state.order)
  const activeKey = useRemoteThreads((state) => state.activeKey)
  const groups = useMemo(() => groupByDevice(order.flatMap((key) => (entries[key] ? [entries[key]!] : []))), [entries, order])
  if (groups.length === 0) return null
  const open = async (key: string) => {
    if (!await confirmNavigation()) return
    const store = useAppStore.getState()
    store.setSidebarMode('projects')
    store.setScheduledOpen(false)
    store.setChannelsOpen(false)
    selectRemoteThread(key)
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.node} className="threads-sidebar-section remote-threads-section" aria-label={`Threads on ${group.name}`}>
          <div className="threads-sidebar-heading">
            <span className="threads-sidebar-heading-label remote-threads-heading">
              <Laptop size={14} strokeWidth={2} aria-hidden="true" />
              <span title={group.name}>{group.name}</span>
            </span>
          </div>
          <div className="threads-sidebar-tree">
            {group.threads.map((thread) => {
              const name = thread.view?.thread.name ?? thread.title ?? 'Remote thread'
              const active = activeKey === thread.key
              return (
                <div key={thread.key} className="threads-sidebar-thread-container">
                  <button
                    type="button"
                    className={`threads-sidebar-thread${active ? ' active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => void open(thread.key)}
                  >
                    {active && <span className="threads-sidebar-selected-dot" aria-hidden="true" />}
                    <span className="threads-sidebar-thread-name"><span className="threads-sidebar-thread-name-text">{name}</span></span>
                  </button>
                  <span className="threads-sidebar-thread-actions">
                    <button
                      type="button"
                      className="threads-sidebar-thread-action"
                      aria-label={`Detach ${name}`}
                      title="Detach"
                      onClick={() => closeRemoteThread(thread.key)}
                    >
                      <X size={13} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </>
  )
}
