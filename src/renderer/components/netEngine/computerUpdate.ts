import type { SshRecordView } from '../../../shared/net/local'
import { versionTag, type Device } from '../../lib/netDevices'

/**
 * How a computer that is behind gets this computer's version, as its row in Settings → Devices offers it:
 * - `ssh`: this computer installed it over SSH, and updates it the same way (Update…).
 * - `request`: its app is open and takes update requests from here (Update).
 * - `there`: it is updated on itself; `hint` says why not from here, `reason` the same in a few words (the update
 *   list's rows), and `check` whether asking it again may help.
 */
export type ComputerUpdateWay =
  | { kind: 'ssh'; record: SshRecordView; detail: string }
  | { kind: 'request'; detail: string }
  | { kind: 'there'; hint: string; reason: string; detail: string; check: boolean }

/**
 * The way to update `device`, or undefined when it is not behind. `canAsk` is false for a computer that only uses
 * this one: only a computer this one uses can be asked to update.
 */
export function computerUpdateWay(
  device: Pick<Device, 'name' | 'state' | 'version' | 'olderThanThis' | 'newerThanThis' | 'otherChannel' | 'update'> | undefined,
  options: { name: string; current?: string; record?: SshRecordView; canAsk?: boolean }
): ComputerUpdateWay | undefined {
  const { name, current, record, canAsk = false } = options
  const tag = device ? versionTag({ ...device, name }, current) : undefined
  if (!device || tag?.label !== 'Behind') return undefined
  const detail = tag.detail
  if (record?.owner === 'managed') return { kind: 'ssh', record, detail }
  const online = device.state === 'open'
  const update = device.update
  if (canAsk && online && current && update?.requests) return { kind: 'request', detail }
  // Only it uses this computer: it can't be asked from here.
  if (!canAsk) return { kind: 'there', hint: `Update Mousse on ${name}.`, reason: 'Paired one way', detail, check: false }
  // A development build here has no release to send: the other computer is updated on itself.
  if (!current) return { kind: 'there', hint: `Update Mousse on ${name}.`, reason: 'Update it there', detail, check: false }
  // What it last said about updating itself (or that it said nothing) holds while it is offline too.
  if (update && !update.self)
    return {
      kind: 'there',
      hint: `It can't update itself${update.reason ? `: ${update.reason.replace(/\.$/, '')}` : ''}. Update it on ${name}.`,
      reason: update.reason?.replace(/\.$/, '') || "Can't update itself",
      detail,
      check: false
    }
  if (!update)
    return {
      kind: 'there',
      hint: `Its Mousse is too old to update from here. Update it on ${name} once.`,
      reason: 'Too old to update from here',
      detail,
      check: online
    }
  if (!online) return { kind: 'there', hint: `Offline. Update it here once it's back, or on ${name}.`, reason: 'Offline', detail, check: false }
  return { kind: 'there', hint: `Open Mousse on ${name} to update it from here.`, reason: "Mousse isn't open there", detail, check: true }
}
