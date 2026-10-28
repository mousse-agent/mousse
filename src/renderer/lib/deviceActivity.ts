import { describeDeviceActivity, formatBytes, type DeviceActivity, type DeviceRuleView } from '../../shared/bridge/deviceActivity'
import { describePermissionMode } from '../../shared/permissionMode'
import type { Device } from './netDevices'
import { isComputer, worksOnThreads } from './netDevices'

/** The one line under "Activity": what the device did in the last 7 days, in plain words. */
export function activityHeadline(activity: Pick<DeviceActivity, 'counts' | 'uncertain' | 'refused'>): string {
  const did = describeDeviceActivity(activity.counts)
  const parts = [did ? `${did} in the last 7 days` : 'Has changed nothing here in the last 7 days']
  if (activity.uncertain) parts.push(`${activity.uncertain} may not have finished`)
  if (activity.refused) parts.push(`${activity.refused} refused`)
  return parts.join(' · ')
}

/** What the device read in the last 24 hours. */
export function readsLine(reads: DeviceActivity['reads']): string {
  if (!reads.calls) return 'It has read nothing from this computer in the last 24 hours.'
  return `It read from this computer ${reads.calls === 1 ? 'once' : `${reads.calls} times`} (${formatBytes(reads.bytes)}) in the last 24 hours.`
}

/** "Rules it made": how many, and in how many threads. */
export function rulesLine(rules: readonly DeviceRuleView[]): string {
  const threads = new Set(rules.map((row) => row.threadId)).size
  return `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'} in ${threads} ${threads === 1 ? 'thread' : 'threads'} answer for the owner without asking. Clear them and the next such action asks again.`
}

const ACTION_WORDS = { command: 'a command', edit: 'an edit', tool: 'a tool' } as const

/** What one rule allows, and under which permission mode it was given. */
export function ruleLine(row: DeviceRuleView): string {
  const parts = [`allows ${ACTION_WORDS[row.rule.action] ?? 'an action'}`, `given under ${describePermissionMode(row.rule.grantedUnder)}`]
  if (!row.rule.active) parts.push('not in use while the thread asks first')
  return parts.join(' · ')
}

/**
 * Whether a device gets an Activity row: a computer this build can ask about that works on threads, or has left
 * something behind (changes, or rules that still answer for the owner).
 */
export function showsActivity(device: Pick<Device, 'kind' | 'policy' | 'caps'>, activity: DeviceActivity | undefined): boolean {
  if (!activity || !device.policy || !isComputer(device)) return false
  return worksOnThreads(device) || activity.entries.length > 0 || activity.rules.length > 0
}
