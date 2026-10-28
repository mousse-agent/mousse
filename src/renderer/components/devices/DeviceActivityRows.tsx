import { useCallback, useEffect, useRef, useState } from 'react'
import { SettingsRow } from '../settings/SettingsRow'
import { useDaemonCall } from './useDaemonCall'
import { openThread } from '../../lib/openThread'
import { formatAgo } from '../../lib/formatAgo'
import { activityHeadline, readsLine, ruleLine, rulesLine, showsActivity } from '../../lib/deviceActivity'
import { useAppStore } from '../../stores/appStore'
import { describeActivityEntry, type DeviceActivity, type DeviceRulesCleared, type DeviceRuleView } from '../../../shared/bridge/deviceActivity'
import type { Device } from '../../lib/netDevices'

/** How often an open Devices screen asks again. The audit is one small query on this computer. */
const REFRESH_MS = 10_000

function ThreadLink({ id, name, onOpen }: { id: string; name: string | null; onOpen: (id: string) => void }) {
  if (name === null) return <span className="settings-muted">a deleted thread</span>
  return <button type="button" className="devices-activity-link" title="Open this thread" onClick={() => onOpen(id)}>{name || 'Untitled thread'}</button>
}

export interface DeviceActivityViewProps {
  name: string
  activity: DeviceActivity
  now: number
  open: boolean
  busy: boolean
  blocked: boolean
  onToggle(): void
  onOpenThread(id: string): void
  onClearRule(row: DeviceRuleView): void
  onClearAll(): void
  /** Absent when the device has no limits to edit here. */
  onLimits?(): void
  onBlock(blocked: boolean): void
}

/**
 * What one other computer did on this one, under its row in Devices: a line of plain words, the recent actions
 * with links to the threads they were about, what it read, and the "Always" rules it made with Clear. The
 * device's Block and limits sit in the same row, so what it did and what it may do are read together.
 */
export function DeviceActivityView({ name, activity, now, open, busy, blocked, onToggle, onOpenThread, onClearRule, onClearAll, onLimits, onBlock }: DeviceActivityViewProps) {
  return <>
    <SettingsRow
      indent
      title="Activity on this computer"
      description={activityHeadline(activity)}
      control={<>
        <button type="button" className="settings-btn" aria-expanded={open} onClick={onToggle}>{open ? 'Hide details' : 'Show details'}</button>
        {onLimits && <button type="button" className="settings-btn" disabled={busy} onClick={onLimits}>Limits…</button>}
        <button type="button" className={blocked ? 'settings-btn' : 'settings-btn devices-block-btn'} disabled={busy} onClick={() => onBlock(!blocked)}>{blocked ? 'Unblock' : 'Block'}</button>
      </>}
    >
      {open && (
        <div className="devices-activity" aria-label={`What ${name} did on this computer`}>
          {activity.entries.length ? (
            <ul className="devices-activity-list">
              {activity.entries.map((entry, index) => (
                <li key={`${entry.at}-${entry.method}-${index}`}>
                  <span className="devices-activity-when">{formatAgo(entry.at, now)}</span>
                  <span className={entry.kind === 'refused' ? 'devices-activity-what refused' : 'devices-activity-what'}>{describeActivityEntry(entry)}</span>
                  {entry.thread && <span className="devices-activity-where">in <ThreadLink id={entry.thread.id} name={entry.thread.name} onOpen={onOpenThread} /></span>}
                  {entry.project?.name && <span className="devices-activity-where">project {entry.project.name}</span>}
                </li>
              ))}
            </ul>
          ) : <p className="settings-muted devices-note">Nothing yet.</p>}
          <p className="settings-muted devices-note">{readsLine(activity.reads)}</p>
        </div>
      )}
    </SettingsRow>
    {activity.rules.length > 0 && (
      <SettingsRow
        indent
        title={`"Always" rules made on ${name}`}
        description={rulesLine(activity.rules)}
        control={<button type="button" className="settings-btn" disabled={busy} onClick={onClearAll}>Clear all</button>}
      >
        <ul className="devices-rules">
          {activity.rules.map((row) => (
            <li key={`${row.threadId}/${row.rule.id}`}>
              <div>
                <code className="devices-code">{row.rule.summary || row.rule.permissionKey}</code>
                <div className="settings-muted devices-rule-meta">{ruleLine(row)} · in <ThreadLink id={row.threadId} name={row.threadName} onOpen={onOpenThread} /></div>
              </div>
              <button type="button" className="settings-btn" disabled={busy} onClick={() => onClearRule(row)}>Clear</button>
            </li>
          ))}
        </ul>
      </SettingsRow>
    )}
  </>
}

/**
 * Asks this computer what the device did and keeps the answer fresh. Nothing is shown for a device it cannot
 * ask about (an older daemon, networking off) or one that has done nothing and does not work on threads.
 */
export function DeviceActivityRows({ device, onLimits, onBlock }: {
  device: Device
  onLimits?: () => void
  onBlock: (blocked: boolean) => void
}) {
  const [activity, setActivity] = useState<DeviceActivity>()
  const [open, setOpen] = useState(false)
  const { busy, error, call } = useDaemonCall()
  const node = device.node
  const alive = useRef(true)
  const load = useCallback(async () => {
    try {
      const value = await window.mousse.platformRequest.request<DeviceActivity>('bridge.activity', { node })
      if (alive.current) setActivity(value)
    } catch {
      // This computer cannot say (an older daemon, or networking is off): the row is left out.
    }
  }, [node])
  useEffect(() => {
    alive.current = true
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => { alive.current = false; clearInterval(timer) }
  }, [load])

  const clear = async (target?: DeviceRuleView) => {
    const answer = await call<DeviceRulesCleared>('bridge.clearDeviceRules', { node, ...(target ? { threadId: target.threadId, ruleId: target.rule.id } : {}) })
    if (answer) setActivity((current) => current && { ...current, rules: answer.value.rules })
  }
  const show = (threadId: string) => {
    void openThread(threadId).then(() => {
      if (useAppStore.getState().activeThreadId === threadId) useAppStore.getState().setSettingsOpen(false)
    })
  }

  if (!showsActivity(device, activity)) return null
  return <>
    <DeviceActivityView
      name={device.name}
      activity={activity!}
      now={Date.now()}
      open={open}
      busy={busy}
      blocked={!!device.policy?.blocked}
      onToggle={() => setOpen((value) => !value)}
      onOpenThread={show}
      onClearRule={(row) => void clear(row)}
      onClearAll={() => void clear()}
      onLimits={onLimits}
      onBlock={onBlock}
    />
    {error && <p role="alert" className="chat-error devices-error">{error}</p>}
  </>
}
