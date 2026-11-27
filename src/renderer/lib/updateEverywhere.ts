import { compareVersions, isDevBuild } from '../../shared/net/version'
import type { NetEngineStatus } from '../../shared/netEngine/local'
import { rolloutTargets, SELF_NODE, type RolloutRow } from '../../shared/updateRollout'
import { computerUpdateWay } from '../components/netEngine/computerUpdate'
import { engineSides } from '../components/netEngine/engineRows'
import type { Device } from './netDevices'

/**
 * The update list's computers: this one and each paired computer, with the version it runs, how it gets the version
 * this computer updates to, or why it can't. Update everywhere's confirmation shows the same rows. Which computers
 * Update everywhere really updates is the service's plan (`updates.rollout.get`); the reasons for the others come from
 * `computerUpdateWay`, as on their rows in Settings → Devices.
 */
export interface ComputerUpdateRow {
  /** The computer's node, or `SELF_NODE`. */
  node: string
  name: string
  /** The version it runs. */
  from?: string
  /** Update everywhere updates it. */
  updates: boolean
  /** It already runs the version. */
  current?: true
  /** How it updates, or why it can't, in a few words. */
  how: string
  /** What Update everywhere does there. */
  plan: string
  /** The full reason, for the tooltip. */
  detail?: string
}

export interface ComputerUpdateInput {
  /** The devices as `bridge.nodes` lists them. */
  devices: readonly Device[]
  /** Nodes paired one way that only use this computer: this one can't ask them anything. */
  oneWay: ReadonlySet<string>
  /** The service's rows for a rollout to `target`, once read. */
  plan?: readonly RolloutRow[]
  /** The version this computer runs. */
  current?: string
  /** The version Update everywhere brings every computer to. */
  target?: string
}

const SELF_HOW = 'Downloads, then restarts'
const WAYS: Record<'request' | 'ssh', { how: string; plan: string }> = {
  request: { how: 'Updates from here', plan: '10-second countdown there' },
  ssh: { how: 'Updates over SSH', plan: 'Installs over SSH' }
}

/** "Skipped · offline": the reason in lower case, a name kept as written. */
export function skippedText(reason: string): string {
  const first = reason.split(' ')[0]
  const keep = first === 'Mousse' || /^[A-Z]{2}/.test(first)
  return `Skipped · ${keep ? reason : reason.charAt(0).toLowerCase() + reason.slice(1)}`
}

const below = (version: string | undefined, target: string | undefined): boolean =>
  !!version && !!target && !isDevBuild(version) && !isDevBuild(target) && compareVersions(version, target) === -1

/** This computer first, then the ones Update everywhere updates, the skipped ones, and the ones already current. */
export function computerUpdateRows(input: ComputerUpdateInput): ComputerUpdateRow[] {
  const { devices, oneWay, plan, current, target } = input
  const planned = new Map((plan ?? []).map((row) => [row.node, row]))
  const targets = new Set(rolloutTargets(plan ?? []).map((row) => row.node))

  const ownPlan = planned.get(SELF_NODE)
  const self: ComputerUpdateRow =
    ownPlan?.via === 'manual'
      ? { node: SELF_NODE, name: 'This computer', from: current, updates: false, how: ownPlan.error ?? 'Update it by hand', plan: skippedText(ownPlan.error ?? 'Update it by hand') }
      : ownPlan || below(current, target)
        ? { node: SELF_NODE, name: 'This computer', from: current, updates: true, how: SELF_HOW, plan: 'Restarts last' }
        : { node: SELF_NODE, name: 'This computer', from: current, updates: false, current: true, how: 'Up to date', plan: 'Up to date' }

  const rows: ComputerUpdateRow[] = []
  const seen = new Set<string>()
  for (const device of devices) {
    if (device.self || device.revoked || device.kind === 'phone' || seen.has(device.node)) continue
    seen.add(device.node)
    const base = { node: device.node, name: device.name, ...(device.version ? { from: device.version } : {}) }
    const row = planned.get(device.node)
    const way = computerUpdateWay(device, { name: device.name, current, canAsk: !oneWay.has(device.node) })
    if (row && targets.has(row.node) && (row.via === 'request' || row.via === 'ssh')) {
      rows.push({ ...base, updates: true, ...WAYS[row.via] })
      continue
    }
    if (row) {
      const reason = way?.kind === 'there' ? way.reason : (row.error ?? 'Update it there')
      rows.push({ ...base, updates: false, how: reason, plan: skippedText(reason), detail: way?.kind === 'there' ? way.hint : row.error })
      continue
    }
    if (way?.kind === 'request' || way?.kind === 'ssh') {
      // Before the plan is read: the way its Devices row offers.
      rows.push({ ...base, updates: !plan, ...WAYS[way.kind] })
      continue
    }
    if (way?.kind === 'there') {
      rows.push({ ...base, updates: false, how: way.reason, plan: skippedText(way.reason), detail: way.hint })
      continue
    }
    if (device.otherChannel) {
      rows.push({ ...base, updates: false, how: 'Other update channel', plan: skippedText('Other update channel') })
      continue
    }
    if (device.version && isDevBuild(device.version)) {
      rows.push({ ...base, updates: false, how: 'Development build', plan: skippedText('Development build') })
      continue
    }
    if (device.version && target && !below(device.version, target)) {
      rows.push({ ...base, updates: false, current: true, how: 'Up to date', plan: 'Up to date' })
      continue
    }
    // Never said its version: one that only uses this computer says nothing to it.
    if (oneWay.has(device.node)) rows.push({ ...base, updates: false, how: 'Paired one way', plan: skippedText('Paired one way') })
  }
  // A computer the plan has and the list does not (yet): as the plan says.
  for (const row of plan ?? []) {
    if (row.node === SELF_NODE || seen.has(row.node)) continue
    seen.add(row.node)
    const base = { node: row.node, name: row.name, ...(row.from ? { from: row.from } : {}) }
    if (targets.has(row.node) && (row.via === 'request' || row.via === 'ssh')) rows.push({ ...base, updates: true, ...WAYS[row.via] })
    else {
      const reason = row.error ?? 'Update it there'
      rows.push({ ...base, updates: false, how: reason, plan: skippedText(reason) })
    }
  }
  const rank = (row: ComputerUpdateRow): number => (row.updates ? 0 : row.current ? 2 : 1)
  return [self, ...rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(({ row }) => row)]
}

/** The nodes paired one way that only use this computer, from `netEngine.status`. */
export function oneWayNodes(status: Pick<NetEngineStatus, 'devices'> | undefined): Set<string> {
  return new Set((status?.devices ?? []).filter((device) => !engineSides(device).includes('out')).map((device) => device.node))
}

/**
 * The computers using this one right now, whose connections drop while it restarts: engine pairings that use this
 * computer and are connected, and connected devices of the older networking (paired both ways).
 */
export function computersUsingThis(devices: readonly Device[], status: Pick<NetEngineStatus, 'devices'> | undefined): Array<{ node: string; name: string }> {
  const engine = new Map((status?.devices ?? []).map((device) => [device.node, device]))
  const seen = new Set<string>()
  const out: Array<{ node: string; name: string }> = []
  for (const device of devices) {
    if (device.self || device.revoked || seen.has(device.node)) continue
    const paired = engine.get(device.node)
    const using = paired
      ? paired.state === 'connected' && engineSides(paired).includes('in')
      : device.source !== 'engine' && device.state === 'open' && device.connection === 'connected'
    if (!using) continue
    seen.add(device.node)
    out.push({ node: device.node, name: device.name })
  }
  return out
}
