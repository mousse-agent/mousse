import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Laptop, Monitor, MonitorSmartphone, Plus, RefreshCw, Smartphone } from '../../lib/icons'
import type {
  NetEngineDevice,
  NetEngineRemoval,
  NetEngineRemovalHost,
  NetEngineStatus
} from '../../../shared/netEngine/local'
import { relayText, routeText } from '../../../shared/netEngine/routes'
import type { PlatformRequestMethod } from '../../../shared/platform'
import type { SshRecordView } from '../../../shared/net/local'
import type { AccessPresetFields } from '../../../shared/net/accessPresets'
import { refreshComputers, useComputers } from '../../lib/computers'
import {
  canWorkOnThreads,
  connectStep,
  heldDevices,
  joinErrorWords,
  passLapsed,
  sshRecordFor,
  versionTag,
  workOnThreadsDisclosure,
  worksOnThreads,
  WORKS_ON_THREADS,
  type Device
} from '../../lib/netDevices'
import { phonesBlocked } from '../../lib/plusEnrollment'
import { takePendingDevice } from '../../lib/settingsNavigation'
import { useAppStore } from '../../stores/appStore'
import { useUpdateStore } from '../../stores/updateStore'
import { useMousseIdAvailable, useMousseIdStore } from '../../stores/mousseIdStore'
import { DeviceLimitsDialog } from '../devices/DeviceLimitsDialog'
import { EditorSshSettings } from '../devices/EditorSshSettings'
import { UndoSetupDialog, UpdateRemoteDialog } from '../devices/SshRecordDialogs'
import { RemoteUpdateDialog } from '../devices/RemoteUpdateDialog'
import { WorkHereRow } from '../devices/WorkHereRow'
import { errorText } from '../devices/useDaemonCall'
import { RowMenu, type RowMenuItem } from '../integrations/RowMenu'
import { MousseIdAccount } from '../MousseIdAccount'
import { AddPhoneDialog, EnrollmentRequestRow, useEnrollmentRequests } from '../MousseIdSection'
import { SettingsAdvanced, SettingsGroup, SettingsRow, Switch } from '../settings/SettingsRow'
import { DelayedLoader } from '../ui/DelayedLoader'
import { Modal } from '../ui/Modal'
import { AccessPanel } from './AccessPanel'
import { AllowPrompt } from './AllowPrompt'
import { EnginePlusGroup } from './EnginePlusGroup'
import { LetDeviceInDialog, type LetDeviceInStart } from './LetDeviceInDialog'
import { UseComputerDialog } from './UseComputerDialog'
import { hasFeatures } from './ways'
import { computerUpdateWay } from './computerUpdate'
import { hostLabel, removalText, removalTitle } from './plusRows'
import {
  askedLine,
  engineAddresses,
  engineSideRow,
  engineSides,
  engineWay,
  engineWhere,
  otherWayItem,
  type EngineSide,
  relayLimitDetail,
  relayLimitLine,
  relayOfferLine,
  RELAY_STALE_DETAIL,
  RELAY_STALE_LINE,
  SHARED_ACCOUNT_DETAIL,
  SHARED_ACCOUNT_LINE
} from './engineRows'
import {
  accessShort,
  legacyHow,
  legacyLine,
  legacyListed,
  legacyOn,
  LegacyHeldRow,
  LegacyJoinRow,
  LegacyShareBotsRow,
  LegacyUnfinishedSshRow,
  LegacyUnlockRow,
  useLegacyNet
} from './legacyRows'
import { LegacyAddonRows, legacyAddonsOn, LegacyRelayRows, legacyRelaysSet, LegacyServeRow } from './LegacyRelayRows'
import { takeOfferedPairLink, useOfferedPairLink } from './PairLinkHost'
import { useEngineStatus } from './useEngineStatus'
import { CodeEntry } from './SendLinkParts'
import { ReachSection } from './ReachSection'
import { RoutesPanel } from './RoutesPanel'
import '../../styles/devices.css'
import './engine.css'

/** What the group says under its title while networking is not simply on. */
function helperLine(status: NetEngineStatus): string | undefined {
  if (status.paused) return status.paused
  if (status.helper.state === 'not_in_build') return status.enabled ? NOT_IN_BUILD : undefined
  if (status.helper.text) return status.helper.text
  if (
    status.enabled &&
    (status.helper.state === 'starting' || status.helper.state === 'restarting')
  )
    return 'Starting…'
  return undefined
}

const NOT_IN_BUILD = "Networking isn't in this build."

/** "Agigo", "Agigo or Agiro", "Agigo, Agiro or Agira". */
function orList(names: string[]): string {
  if (names.length < 2) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

type RowView = {
  key: string
  node: string
  side: EngineSide
  name: string
  icon: ReactNode
  line: string
  detail?: string
  warn?: boolean
  /** How it is connected now; the tooltip lists its addresses. */
  how?: string
  howDetail?: string
  access?: string
  /** "Behind" or "Newer" when its Mousse differs from this computer's; the versions are its tooltip. */
  tag?: { label: string; detail: string }
  /** Relay notes after the line. */
  extra?: ReactNode
  items: RowMenuItem[]
  quiet?: boolean
}

/** A computer behind: Update (or Check again) beside the row's menu, and where to update it when not from here. */
type RowUpdate = { control?: ReactNode; hint?: ReactNode }

/** A row's key: one per direction, so a pairing both ways has a row in each list. */
const sideKey = (node: string, side: EngineSide): string => `${node}:${side}`

/**
 * Settings → Devices (design §7): one Networking switch and two lists, the computers this one uses and the devices
 * that can use it, then what this computer shares and how other computers reach it. Each direction of a pairing is
 * its own row; a pairing both ways shows in both lists. The old networking's devices (paired before the engine, and
 * phones) sit in the same lists and open the same Access panel.
 */
export function EngineDevicesSection() {
  const { status, read } = useEngineStatus()
  const legacy = useLegacyNet()
  const v1 = legacy.status
  const v1On = legacyOn(v1)
  const v1Ready = v1On && !!v1?.self && v1?.keystore === 'unlocked'
  const { devices: nodes } = useComputers(!!status?.on || v1Ready)
  const current = useUpdateStore((s) => s.currentVersion) || undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Which add dialog is open: `in`, Let a device in; `out`, Use another computer.
  const [adding, setAdding] = useState<EngineSide>()
  // Where Let a device in opens when Reach this computer opened it: the tunnel's setup, or a link over it.
  const [letInFrom, setLetInFrom] = useState<LetDeviceInStart>()
  const letIn = (from: LetDeviceInStart) => {
    setLetInFrom(from)
    setAdding('in')
  }
  const [addingPhone, setAddingPhone] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [picked, setPicked] = useState<string>()
  const [removing, setRemoving] = useState<{ device: NetEngineDevice; side: EngineSide }>()
  const [revoking, setRevoking] = useState<Device>()
  const [limits, setLimits] = useState<Device>()
  const [granting, setGranting] = useState<Device>()
  const [givingUp, setGivingUp] = useState(false)
  const [notNow, setNotNow] = useState<string[]>([])
  const [recordDialog, setRecordDialog] = useState<{
    kind: 'undo' | 'update'
    record: SshRecordView
    name: string
  }>()
  // Updating another computer from here (it takes update requests: its app is running there).
  const [updating, setUpdating] = useState<{ node: string; name: string; version: string; runs?: string }>()
  // A computer behind that updates itself but did not say it takes requests may have opened its app since it last
  // said: asked again once while Devices is open, so Update shows for it.
  const asked = useRef(new Set<string>())
  const reloadLegacy = legacy.reload
  useEffect(() => {
    // Rows of the new networking read the computers list; the old networking's read its own.
    const stale = [...nodes, ...legacy.devices].filter(
      (device) =>
        device.state === 'open' &&
        device.update?.self &&
        !device.update.requests &&
        !asked.current.has(device.node) &&
        versionTag(device, current)?.label === 'Behind'
    )
    if (!stale.length) return
    for (const device of stale) asked.current.add(device.node)
    void Promise.allSettled(
      stale.map((device) => window.mousse.platformRequest.request('net.update.there', { node: device.node, step: 'refresh' }))
    ).then(() => {
      void refreshComputers()
      void reloadLegacy().catch(() => undefined)
    })
  }, [nodes, legacy.devices, reloadLegacy, current])
  // Check again on a computer behind: asking it now, or what it answered (the same, or nothing).
  const [checks, setChecks] = useState<Record<string, 'checking' | 'same' | 'failed'>>({})
  const checkAgain = async (node: string) => {
    setChecks((now) => ({ ...now, [node]: 'checking' }))
    let answer: 'same' | 'failed' = 'same'
    try {
      // `version` keeps what it answers, like `refresh`, but fails when it does not answer now.
      await window.mousse.platformRequest.request('net.update.there', { node, step: 'version' })
    } catch {
      answer = 'failed'
    }
    await Promise.allSettled([refreshComputers(), reloadLegacy()])
    // Once it takes requests, its row shows Update instead and this answer is not shown.
    setChecks((now) => ({ ...now, [node]: answer }))
  }
  const [everywhere, setEverywhere] = useState<NetEngineDevice>()
  // "Let <name> use this computer…": the Allow prompt for a computer this one uses.
  const [letting, setLetting] = useState<NetEngineDevice>()
  // A `mousse://pair` link that opened Mousse opens Scan or paste with it.
  const offered = useOfferedPairLink()
  const [linkToEnter, setLinkToEnter] = useState<string>()
  useEffect(() => {
    if (!offered || !status) return
    const link = takeOfferedPairLink()
    if (link) setLinkToEnter(link)
  }, [offered, status])

  // A device asked for from elsewhere in the app (an editor that needs it) opens with its access in view.
  useEffect(() => {
    const pick = () => {
      const node = takePendingDevice()
      if (node) {
        setPicked(node)
        setSelected(sideKey(node, 'in'))
      }
    }
    pick()
    window.addEventListener('mousse:settings-device', pick)
    return () => window.removeEventListener('mousse:settings-device', pick)
  }, [])
  useEffect(() => {
    if (!picked) return
    // Its Can use row, where its access is; else its other row.
    ;(
      document.querySelector(`[data-device-node="${picked}"][data-device-side="in"]`) ??
      document.querySelector(`[data-device-node="${picked}"]`)
    )?.scrollIntoView?.({ block: 'center' })
    const timer = window.setTimeout(() => setPicked(undefined), 4000)
    return () => window.clearTimeout(timer)
  }, [picked, status, legacy.devices.length])

  const reloadAll = () => {
    read()
    void refreshComputers()
    void legacy.reload().catch(() => undefined)
  }
  const action = async (method: PlatformRequestMethod, params: unknown): Promise<unknown> => {
    setBusy(true)
    setError('')
    try {
      return (await window.mousse.platformRequest.request(method, params)) ?? true
    } catch (cause) {
      const failure = cause as { code?: unknown; details?: unknown; message?: unknown }
      // A lapsed pass is told by the Reconnecting note; a join's failure is told in plain words.
      if (method === 'net.join.retry') setError(joinErrorWords(failure))
      else if (failure?.code !== 'bad_delegation') setError(errorText(cause))
      return undefined
    } finally {
      setBusy(false)
      reloadAll()
    }
  }

  // Mousse ID: its account sits at the top; phones and the Mousse relay go through it.
  const mousseId = useMousseIdAvailable()
  const plus = useMousseIdStore((s) => s.plus)
  const lapsed = passLapsed(v1)
  const signedOut = mousseId && !!v1 && !plus?.connected && !plus?.reconnecting && !lapsed
  const phoneBlocked = phonesBlocked(v1, plus)
  const enrollment = useEnrollmentRequests(mousseId && !phoneBlocked, () => {
    void legacy.reload().catch(() => undefined)
    void useMousseIdStore.getState().refresh()
  })

  if (!status && !v1) return null
  const notInBuild = !status || status.helper.state === 'not_in_build'
  const switchOn = !!status?.enabled || v1On
  const line = !status ? undefined : notInBuild && !switchOn ? NOT_IN_BUILD : helperLine(status)
  const authority = !!v1?.self?.isAuthority
  const locked = v1?.keystore === 'locked'
  const now = Date.now()
  const switches = { workOnThreads: v1?.workOnThreads !== false, shareBots: v1?.shareBots !== false }

  const toggleNetworking = async (next: boolean) => {
    if (next) {
      await action('netEngine.enable', {})
      return
    }
    setSelected(undefined)
    if (status?.enabled) await action('netEngine.disable', {})
    if (v1On) await action('net.disable', {})
  }
  // Adding turns networking on first; nothing listens until then.
  const addDevice = async (side: EngineSide) => {
    if (notInBuild) {
      // Without the helper, Let a device in is Add a phone alone.
      if (side === 'in') setAddingPhone(true)
      return
    }
    if (status && !status.enabled) await action('netEngine.enable', {})
    setLetInFrom(undefined)
    setAdding(side)
  }
  const canAddPhone = mousseId && !phoneBlocked
  const canUse = !notInBuild
  const canLetIn = !notInBuild || canAddPhone
  // Ending one direction of a pairing both ways needs the helper's local revoke; without it Remove ends both.
  const oneDirection = (device: NetEngineDevice, side: EngineSide): boolean =>
    engineSides(device).length === 2 && (side === 'out' || hasFeatures(status, 'grant-revoke-local'))

  const toggle = (key: string) => setSelected((current) => (current === key ? undefined : key))
  const accessItem = (node: string): RowMenuItem => {
    const key = sideKey(node, 'in')
    return {
      label: selected === key ? 'Hide access' : 'Access',
      action: 'device-access',
      onSelect: () => toggle(key)
    }
  }

  const engineView = (device: NetEngineDevice, side: EngineSide): RowView => {
    const view = engineSideRow(device, side)
    const key = sideKey(device.node, side)
    const node = nodes.find((item) => item.node === device.node)
    const connected = view.line === 'Connected'
    const relay = device.relay
    // Remove on all my hosts goes with the device's use of computers: its Can use row, else its only row.
    const everywhereItem: RowMenuItem[] =
      status?.identity && (side === 'in' || !engineSides(device).includes('in'))
        ? [
            {
              label: 'Remove on all my hosts…',
              danger: true,
              action: 'engine-remove-everywhere',
              onSelect: () => setEverywhere(device)
            }
          ]
        : []
    // An allowed relay route can be taken back from the row (Phase 3 §B.11), before Remove.
    const relayItems: RowMenuItem[] =
      side === 'in' || device.state === 'removing'
        ? []
        : (relay?.allowed ?? []).map((destination) => ({
            label: `Stop using relay ${relayText(destination)}`,
            action: 'engine-relay-disallow',
            title: `${device.name} is no longer reached through this relay.`,
            onSelect: () => void action('netEngine.relay.disallow', { node: device.node, destination })
          }))
    const items: RowMenuItem[] = view.actions.flatMap((kind): RowMenuItem[] =>
      kind === 'access'
        ? [accessItem(device.node)]
        : kind === 'address'
          ? [
              // Its routes show in the open row.
              {
                label: selected === key ? 'Hide routes' : 'Routes',
                action: 'device-routes',
                onSelect: () => toggle(key)
              }
            ]
          : kind === 'retry'
            ? [
                {
                  label: 'Retry',
                  action: 'engine-retry',
                  onSelect: () => void action('netEngine.retry', { node: device.node })
                }
              ]
            : [
                ...relayItems,
                ...everywhereItem,
                {
                  label: 'Remove…',
                  danger: true,
                  action: 'engine-remove',
                  onSelect: () => setRemoving({ device, side })
                }
              ]
    )
    if (!view.actions.includes('remove')) items.push(...relayItems)
    // The missing direction of a pairing made one way comes first.
    const other = otherWayItem(device, side)
    if (other)
      items.unshift({
        ...other,
        action: 'engine-other-way',
        onSelect: () =>
          side === 'in'
            ? void action('netEngine.access.ask', { node: device.node })
            : setLetting(device)
      })
    // Its routes stay at hand on a row with a problem, where a fixed address is often the fix.
    if (side === 'out' && !view.actions.includes('address') && device.state !== 'removing')
      items.unshift({
        label: selected === key ? 'Hide routes' : 'Routes',
        action: 'device-routes',
        onSelect: () => toggle(key)
      })
    // The level holds whatever the old networking says of its connection: one way, this computer never dials it,
    // and the row's own state already says whether it is connected.
    const access =
      side === 'in' && !view.warn && node
        ? accessShort({ ...node, connection: undefined }, { workOnThreads: true, shareBots: true })
        : undefined
    return {
      key,
      node: device.node,
      side,
      name: device.name,
      icon: <Laptop size={16} />,
      line: view.line,
      detail: view.detail,
      warn: view.warn,
      how: connected ? engineWhere(device) : undefined,
      howDetail: engineAddresses(device),
      access,
      tag: node ? versionTag({ ...node, name: device.name }, current) : undefined,
      extra:
        side === 'out' ? (
          <>
            {relay?.stale && (
              <>
                {' · '}
                <span className="settings-muted" title={RELAY_STALE_DETAIL(device.name)}>
                  {RELAY_STALE_LINE}
                </span>
              </>
            )}
            {relay?.limit && (
              <>
                {' · '}
                <span className="settings-muted" title={relayLimitDetail(relay.limit.callersMax)}>
                  {relayLimitLine(relay.limit.callersMax)}
                </span>
              </>
            )}
          </>
        ) : undefined,
      items
    }
  }

  const legacyView = (device: Device, side: EngineSide): RowView => {
    const record = sshRecordFor(device, legacy.ssh)
    const state = legacyLine(device, now, { signedOut })
    const step = connectStep(device)
    const items: RowMenuItem[] = [
      ...(side === 'in' && device.policy ? [accessItem(device.node)] : []),
      ...(side === 'out' && step && 'connect' in step
        ? [
            {
              label: 'Connect',
              action: 'legacy-connect',
              onSelect: () => void action('bridge.connect', { node: device.node })
            }
          ]
        : []),
      ...(side === 'out' && record?.owner === 'managed' && !device.olderThanThis
        ? [
            {
              label: 'Update…',
              action: 'legacy-update',
              onSelect: () => setRecordDialog({ kind: 'update', record, name: device.name })
            }
          ]
        : []),
      ...(side === 'out' && record
        ? [
            {
              label: 'Undo setup…',
              action: 'legacy-undo',
              onSelect: () => setRecordDialog({ kind: 'undo', record, name: device.name })
            }
          ]
        : []),
      ...(authority
        ? [{ label: 'Remove…', danger: true, action: 'legacy-remove', onSelect: () => setRevoking(device) }]
        : [])
    ]
    return {
      key: sideKey(device.node, side),
      node: device.node,
      side,
      name: device.name,
      icon: device.kind === 'phone' ? <Smartphone size={16} /> : <Laptop size={16} />,
      line: state.line,
      detail: state.detail,
      warn: state.warn,
      access: side === 'in' && !state.warn ? accessShort(device, switches) : undefined,
      tag: versionTag(device, current),
      items,
      // Signed out, devices that are not nearby are quiet.
      quiet: signedOut && device.state !== 'open'
    }
  }

  const row = (view: RowView, idTip?: string, update?: RowUpdate) => {
    const open = selected === view.key
    return (
      <SettingsRow
        key={view.key}
        data-device-node={view.node}
        data-device-side={view.side}
        className={[
          open ? 'engine-row-selected' : '',
          picked === view.node && (view.side === 'in' || !rowSides.get(view.node)?.has('in')) ? 'devices-row-picked' : ''
        ]
          .filter(Boolean)
          .join(' ') || undefined}
        disabled={view.quiet}
        leading={view.icon}
        title={idTip ? <span title={idTip}>{view.name}</span> : view.name}
        description={
          // Can use: level · state · how. Computers I use: state · how.
          <span className="engine-row-line">
            {view.access && <>{view.access}{' · '}</>}
            <span className={view.warn ? 'settings-status-warn' : undefined} title={view.detail}>
              {view.line}
            </span>
            {view.how && (
              <>
                {' · '}
                <span title={view.howDetail}>{view.how}</span>
              </>
            )}
            {view.tag && (
              <>
                {' · '}
                <span
                  className={view.tag.label === 'Behind' ? 'settings-status-warn' : undefined}
                  title={view.tag.detail}
                >
                  {view.tag.label}
                </span>
              </>
            )}
            {view.extra}
            {update?.hint}
          </span>
        }
        control={
          update?.control || view.items.length ? (
            <span className="device-row-controls">
              {update?.control}
              {view.items.length > 0 && <RowMenu label={`Actions for ${view.name}`} items={view.items} disabled={busy} />}
            </span>
          ) : undefined
        }
      />
    )
  }

  /**
   * A computer that is behind gets its update on its own row: Update beside its menu when this computer can update
   * it (over SSH, or through its app's update requests), otherwise one muted line saying where and why, with Check
   * again when its app may have opened since it last said.
   */
  const updateView = (
    name: string,
    device: Device | undefined,
    record?: SshRecordView,
    canAsk = false
  ): RowUpdate | undefined => {
    const way = computerUpdateWay(device, { name, current, record, canAsk })
    if (!way || !device) return undefined
    if (way.kind === 'ssh')
      return {
        control: (
          <button
            type="button"
            className="settings-btn device-update-btn"
            disabled={busy}
            title={`Updates ${name} over SSH, as this computer installed it`}
            onClick={() => setRecordDialog({ kind: 'update', record: way.record, name })}
          >
            <ArrowUp size={14} aria-hidden="true" />
            Update…
          </button>
        )
      }
    if (way.kind === 'request')
      return {
        control: (
          <button
            type="button"
            className="settings-btn device-update-btn"
            disabled={busy || !!updating}
            title={`Installs ${current} on ${name} after a 10-second countdown there`}
            onClick={() => setUpdating({ node: device.node, name, version: current!, ...(device.version ? { runs: device.version } : {}) })}
          >
            <ArrowUp size={14} aria-hidden="true" />
            Update
          </button>
        )
      }
    const check = checks[device.node]
    return {
      hint: (
        <span className="device-update-hint" title={way.detail}>
          {check === 'checking'
            ? `Asking ${name}…`
            : check === 'failed'
              ? `${name} didn't answer. ${way.hint}`
              : check === 'same'
                ? `${way.hint} Same answer just now.`
                : way.hint}
        </span>
      ),
      control: !way.check ? undefined : check === 'checking' ? (
        <DelayedLoader size="small" delayMs={0} label={`Asking ${name}`} />
      ) : (
        <button
          type="button"
          className="settings-icon-btn"
          disabled={busy}
          title={`Check again whether ${name} can be updated from here`}
          aria-label={`Check again whether ${name} can be updated from here`}
          onClick={() => void checkAgain(device.node)}
        >
          <RefreshCw size={14} />
        </button>
      )
    }
  }

  const block = (node: string) => (blocked: boolean) => void action('bridge.policy', { node, blocked })

  const engineDevices = status?.on ? status.devices : []
  const engineNodes = new Set(engineDevices.map((device) => device.node))
  const oldDevices = legacyListed(legacy.devices).filter((device) => !engineNodes.has(device.node))
  // The old networking pairs computers both ways; a phone only uses this computer.
  const oldSides = (device: Device): EngineSide[] => (device.kind === 'phone' ? ['in'] : ['out', 'in'])
  const rowSides = new Map<string, Set<EngineSide>>([
    ...engineDevices.map((device) => [device.node, new Set(engineSides(device))] as const),
    ...oldDevices.map((device) => [device.node, new Set(oldSides(device))] as const)
  ])

  // Computers I use: this computer's direction, with its routes, relay offers and Retry.
  const engineOutRows = engineDevices.flatMap((device) => {
    if (!engineSides(device).includes('out')) return []
    const view = engineView(device, 'out')
    return [
      row(view, `Id ${device.shortId}`, updateView(device.name, nodes.find((item) => item.node === device.node), undefined, true)),
      device.olderApp && (
        <SettingsRow
          key={`${device.node}-older`}
          indent
          title={
            <span className="settings-status-warn">{device.name} runs an older Mousse</span>
          }
          description={
            <span title={`Its own list keeps waiting for this computer. Update Mousse on ${device.name}, or remove it and connect again with “Also let ${device.name} use this computer” ticked.`}>
              Update it, or connect again with “Also let” ticked.
            </span>
          }
        />
      ),
      !!device.offered?.length && (
        <SettingsRow
          key={`${device.node}-offered`}
          indent
          title={`${device.name} offered new ways to reach it`}
          description={
            <span title={`${device.offered.map(routeText).join(', ')}. Not used until you tap Use.`}>
              Use them to connect when it's away from this network
            </span>
          }
          control={
            <button
              type="button"
              className="settings-btn"
              disabled={busy}
              onClick={() => void action('netEngine.address.use', { node: device.node })}
            >
              Use
            </button>
          }
        />
      ),
      ...(device.relay?.offered ?? []).map((destination) => (
        <SettingsRow
          key={`${device.node}-relay-${destination}`}
          indent
          title={relayOfferLine(device.name, destination)}
          control={
            <span className="engine-reach-control" data-mousse-decision="">
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                title="Not asked again for this relay."
                onClick={() =>
                  void action('netEngine.relay.dismiss', { node: device.node, destination })
                }
              >
                Not now
              </button>
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                title="Not dialled until you allow it."
                onClick={() =>
                  void action('netEngine.relay.allow', { node: device.node, destination })
                }
              >
                Allow
              </button>
            </span>
          }
        />
      )),
      selected === view.key && (
        <RoutesPanel
          key={`${device.node}-routes`}
          device={device}
          busy={busy}
          action={action}
          onChanged={reloadAll}
        />
      )
    ]
  })
  // Can use this computer: its direction here, with its level and the Access panel.
  const engineInRows = engineDevices.flatMap((device) => {
    if (!engineSides(device).includes('in')) return []
    const view = engineView(device, 'in')
    const node = nodes.find((item) => item.node === device.node)
    const asked = askedLine(device)
    return [
      row(view, `Id ${device.shortId}`, engineSides(device).includes('out') ? undefined : updateView(device.name, node)),
      asked && (
        <SettingsRow
          key={`${device.node}-asked`}
          indent
          leading={asked.waiting ? <DelayedLoader size="small" delayMs={0} label="Waiting" /> : undefined}
          title={<span title={asked.detail}>{asked.line}</span>}
          control={
            <button
              type="button"
              className="settings-btn"
              disabled={busy}
              title={asked.waiting ? 'Takes the request back.' : undefined}
              onClick={() => void action('netEngine.access.cancel', { node: device.node })}
            >
              {asked.waiting ? 'Cancel' : 'Dismiss'}
            </button>
          }
        />
      ),
      device.olderApp && device.direction === 'in' && (
        <SettingsRow
          key={`${device.node}-older`}
          indent
          title={
            <span className="settings-status-warn">{device.name} runs an older Mousse</span>
          }
          description={
            <span title={`It asks to be used from here as well, but only this computer decides that. To use ${device.name} from here, add it with Use another computer.`}>
              To use it from here, add it from this computer.
            </span>
          }
        />
      ),
      selected === view.key && engineSideRow(device, 'in').actions.includes('access') && (
        <AccessPanel
          key={`${device.node}-access`}
          name={device.name}
          device={node}
          how={view.how}
          busy={busy}
          onChanged={reloadAll}
          onLimits={() => node && setLimits(node)}
          onBlock={block(device.node)}
          onRemove={() => setRemoving({ device, side: 'in' })}
        />
      )
    ]
  })
  const oldOutRows = oldDevices
    .filter((device) => oldSides(device).includes('out'))
    .flatMap((device) => {
      const view = legacyView(device, 'out')
      return [row(view, undefined, updateView(device.name, device, sshRecordFor(device, legacy.ssh), true))]
    })
  const oldInRows = oldDevices.flatMap((device) => [
    row(legacyView(device, 'in')),
    selected === sideKey(device.node, 'in') && (
      <AccessPanel
        key={`${device.node}-access`}
        name={device.name}
        device={device}
        how={legacyHow(device)}
        busy={busy}
        grant={
          authority &&
          canWorkOnThreads(device) && (
            <SettingsRow
              indent
              title="Works on threads"
              description={
                worksOnThreads(device)
                  ? 'On · can open and change this computer’s threads'
                  : 'Off · can’t open or change this computer’s threads'
              }
              control={
                <Switch
                  checked={worksOnThreads(device)}
                  label={`Works on threads for ${device.name}`}
                  disabled={busy}
                  onChange={(next) =>
                    next
                      ? setGranting(device)
                      : void action('bridge.setCaps', {
                          node: device.node,
                          caps: device.caps.filter((cap) => cap !== WORKS_ON_THREADS)
                        })
                  }
                />
              }
            />
          )
        }
        onChanged={reloadAll}
        onLimits={() => setLimits(device)}
        onBlock={block(device.node)}
        onRemove={authority ? () => setRevoking(device) : undefined}
      />
    )
  ])
  const held = heldDevices(legacy.devices).filter(({ device }) => !notNow.includes(device.node))
  const unfinishedJoin = v1 && !v1.self ? v1.unfinishedJoin : undefined
  const unfinishedSsh = legacy.ssh.filter((record) => record.phase !== 'done' && !record.node)
  const removals = status?.on ? removalGroups(status.removals) : []
  const removalAsks = status?.on ? (status.removalAsks ?? []) : []
  const emptyOut = !engineOutRows.length && !oldOutRows.length && !unfinishedJoin && !unfinishedSsh.length
  const emptyIn =
    !engineInRows.length &&
    !oldInRows.length &&
    !held.length &&
    !enrollment.requests.length &&
    !removals.length &&
    !removalAsks.length

  // This computer: what it shares with my other devices.
  const engineWorkHere = status?.workOnThreads !== undefined
  const workHere = engineWorkHere ? status?.workOnThreads : v1Ready ? v1?.workOnThreads : undefined
  const shareBots = v1Ready && v1?.shareBots !== undefined
  const unlock = !!v1?.self && locked
  const thisComputer = workHere !== undefined || shareBots || unlock

  // Reach: the old networking's ways in and relays, only where they are on or set today.
  const oldWays = legacyAddonsOn(legacy) || legacy.records.tailscale?.action === 'serve'
  const relays = legacyRelaysSet(legacy)
  const run = (method: PlatformRequestMethod, params: unknown) => action(method, params)

  const otherComputers = oldDevices.filter((device) => device.kind === 'computer').map((device) => device.name)
  const reconnectingNote = lapsed && (
    <SettingsRow
      indent
      title="This computer’s pass to your devices ran out while it was away"
      description={`Open Mousse on ${otherComputers.length ? orList(otherComputers) : 'your other computer'} and it is brought back in by itself, usually within a minute. Nothing to do here.`}
      control={
        <button
          type="button"
          className="settings-btn"
          disabled={busy}
          onClick={() => {
            reloadAll()
            void useMousseIdStore.getState().refresh()
          }}
        >
          <RefreshCw size={14} />
          Check now
        </button>
      }
    />
  )
  const focusSetUp = () => {
    const element = document.querySelector<HTMLElement>(
      unlock ? '[data-settings-anchor="devices-passphrase"] input' : '[data-settings-anchor="devices-list"] [role="switch"]'
    )
    element?.scrollIntoView?.({ block: 'center' })
    element?.focus()
  }

  return (
    <>
      {mousseId ? (
        <MousseIdAccount onSetUp={focusSetUp} lapsed={lapsed}>
          {reconnectingNote}
        </MousseIdAccount>
      ) : (
        lapsed && <SettingsGroup className="devices-group">{reconnectingNote}</SettingsGroup>
      )}

      <SettingsGroup
        anchor="devices-list"
        title="Computers I use from here"
        icon={Laptop}
        className="devices-group engine-group"
        description={
          status?.sharedAccount ? (
            <span className="settings-status-warn" title={SHARED_ACCOUNT_DETAIL}>
              {SHARED_ACCOUNT_LINE}
            </span>
          ) : undefined
        }
        action={
          <span className="engine-group-actions">
            {canUse && (
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                title="Paste its link, scan its code, or connect over SSH."
                onClick={() => void addDevice('out')}
              >
                <Plus size={14} aria-hidden="true" />
                Use another computer
              </button>
            )}
            {(!notInBuild || switchOn) && (
              <Switch
                checked={switchOn}
                label="Networking"
                disabled={busy}
                onChange={(next) => void toggleNetworking(next)}
              />
            )}
          </span>
        }
      >
        {line && (
          <p className="settings-muted devices-note" role="status">
            {line}
          </p>
        )}
        {status?.enabled && status.loginStart === 'ask' && (
          <SettingsRow
            title="Start Mousse at login so your other computers can reach this one?"
            control={
              <span className="engine-group-actions">
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy}
                  onClick={() => void action('netEngine.loginStart', { start: false })}
                >
                  Not now
                </button>
                <button
                  type="button"
                  className="settings-btn primary"
                  disabled={busy}
                  onClick={() => void action('netEngine.loginStart', { start: true })}
                >
                  Start at login
                </button>
              </span>
            }
          />
        )}
        {unfinishedJoin && (
          <LegacyJoinRow
            name={unfinishedJoin.name}
            locked={locked}
            busy={busy}
            onRetry={(passphrase) => void action('net.join.retry', passphrase ? { passphrase } : {})}
            onGiveUp={() => setGivingUp(true)}
          />
        )}
        {engineOutRows}
        {oldOutRows}
        {unfinishedSsh.map((record) => (
          <LegacyUnfinishedSshRow
            key={record.id}
            record={record}
            busy={busy}
            onUndo={() => setRecordDialog({ kind: 'undo', record, name: record.endpoint })}
          />
        ))}
        {emptyOut && switchOn && <p className="settings-muted devices-note">None yet.</p>}
        {error && (
          <p role="alert" className="chat-error devices-error">
            {error}
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup
        anchor="devices-can-use"
        title="Can use this computer"
        icon={MonitorSmartphone}
        className="devices-group engine-group"
        action={
          canLetIn ? (
            // Search's "Add a phone" lands here: Let a device in has the phone.
            <span className="engine-group-actions" data-settings-anchor="account-phones">
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                title="A code for your phone or another computer."
                onClick={() => void addDevice('in')}
              >
                <Plus size={14} aria-hidden="true" />
                Let a device in
              </button>
            </span>
          ) : undefined
        }
      >
        {enrollment.requests.map((request) => (
          <EnrollmentRequestRow
            key={request.id}
            row={request}
            busy={enrollment.busy}
            onDecide={(approve) => void enrollment.decide(request.id, approve)}
          />
        ))}
        {enrollment.error && (
          <p role="alert" className="chat-error devices-error">
            {enrollment.error}
          </p>
        )}
        {held.map(({ device, side }) => (
          <LegacyHeldRow
            key={`held-${device.node}`}
            device={device}
            side={side}
            busy={busy}
            canRemove={authority}
            onAllow={() => void action('bridge.allow', { node: device.node })}
            onNotNow={() => setNotNow((list) => [...list, device.node])}
            onRemove={() => setRevoking(device)}
          />
        ))}
        {engineInRows}
        {oldInRows}
        {removalAsks.map((ask) => (
            <p
              key={`${ask.host}-${ask.grant}`}
              className="settings-muted devices-note engine-ask"
              role="status"
            >
              <span>
                {ask.name} is also on {hostLabel(ask)}. Remove it there?
              </span>
              <button
                type="button"
                className="settings-btn danger-fill"
                disabled={busy}
                onClick={() =>
                  void action('netEngine.removeEverywhere.answer', {
                    identity: ask.identity,
                    host: ask.host,
                    grant: ask.grant,
                    yes: true
                  })
                }
              >
                Remove
              </button>
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                onClick={() =>
                  void action('netEngine.removeEverywhere.answer', {
                    identity: ask.identity,
                    host: ask.host,
                    grant: ask.grant,
                    yes: false
                  })
                }
              >
                Keep
              </button>
            </p>
          ))}
        {removals.map(([removed, items]) => {
            const title = removalTitle(items[0]!.name || removed.slice(0, 8), items)
            return (
              <SettingsRow
                key={removed}
                data-removal={removed}
                title={
                  <span className={title.warn ? 'settings-status-warn' : undefined}>{title.line}</span>
                }
                description={
                  <span className="engine-row-line">
                    {items.map((item, index) => {
                      const text = removalText(item)
                      return (
                        <span key={item.id}>
                          {index > 0 && ' · '}
                          {hostLabel(item)}:{' '}
                          <span className={text.warn ? 'settings-status-warn' : undefined}>
                            {text.line}
                          </span>
                        </span>
                      )
                    })}
                  </span>
                }
              />
            )
          })}
        {emptyIn && switchOn && <p className="settings-muted devices-note">No devices yet.</p>}
      </SettingsGroup>

      {thisComputer && (
        <SettingsGroup
          title="This computer"
          icon={Monitor}
          className="devices-group"
        >
          {workHere !== undefined && (
            <WorkHereRow
              anchor="devices-inbound"
              on={workHere}
              busy={busy}
              onChange={(next) =>
                void action(engineWorkHere ? 'netEngine.workOnThreads' : 'bridge.workOnThreads', {
                  enabled: next
                })
              }
            />
          )}
          {shareBots && (
            <LegacyShareBotsRow
              on={v1?.shareBots !== false}
              busy={busy}
              onChange={(next) => void action('bridge.shareBots', { enabled: next })}
            />
          )}
          {unlock && (
            <LegacyUnlockRow busy={busy} onUnlock={(passphrase) => void action('net.unlock', { passphrase })} />
          )}
        </SettingsGroup>
      )}

      {status && (
        <EnginePlusGroup status={status} read={read} />
      )}

      {status && (
        <ReachSection
          status={status}
          onChanged={read}
          onSendLink={() => letIn({ kind: 'link', way: 'tunnel' })}
          onCloudflareSetup={() => letIn({ kind: 'tunnel' })}
          moreWays={
            oldWays ? (
              <>
                <LegacyAddonRows net={legacy} busy={busy} run={run} />
                <LegacyServeRow net={legacy} busy={busy} run={run} onError={setError} />
              </>
            ) : undefined
          }
          trailing={relays ? <LegacyRelayRows net={legacy} busy={busy} run={run} /> : undefined}
        />
      )}

      <SettingsAdvanced>
        <EditorSshSettings />
      </SettingsAdvanced>

      {adding === 'in' && (
        <LetDeviceInDialog
          status={status}
          initial={letInFrom}
          onAddPhone={
            canAddPhone
              ? () => {
                  setAdding(undefined)
                  setAddingPhone(true)
                }
              : undefined
          }
          onSetUp={() => {
            // Reach this computer holds the settings each way needs.
            setAdding(undefined)
            window.setTimeout(
              () =>
                document
                  .querySelector('[data-settings-anchor="devices-engine-reach"]')
                  ?.scrollIntoView?.({ block: 'center' }),
              0
            )
          }}
          onClose={() => setAdding(undefined)}
        />
      )}
      {adding === 'out' && <UseComputerDialog status={status} onClose={() => setAdding(undefined)} />}
      {addingPhone && <AddPhoneDialog onClose={() => setAddingPhone(false)} />}

      {linkToEnter && !adding && (
        <UseComputerDialog
          status={status}
          initialLink={linkToEnter}
          onClose={() => setLinkToEnter(undefined)}
        />
      )}

      {/* A Send link join repeated by Retry or after a restart asks for the code here. */}
      {status &&
        !adding &&
        !linkToEnter &&
        (() => {
          const waiting = status.joins?.find((join) => join.needsCode && join.node)
          if (!waiting) return null
          const device = status.devices.find((item) => item.node === waiting.node)
          return (
            <Modal open title={device ? `Pair with ${device.name}` : 'Scan or paste'} onClose={() => undefined}>
              <CodeEntry join={waiting} />
            </Modal>
          )
        })()}


      {/* This owner lets a computer it uses in from its row. A computer's own ask is AccessAskHost's, app-wide. */}
      {status?.on &&
        !adding &&
        letting &&
        (() => {
          const device = letting
          const close = () => setLetting(undefined)
          const answer = async (yes: boolean, access?: AccessPresetFields) => {
            const done = yes ? await action('netEngine.access.let', { node: device.node, access }) : true
            if (done) close()
          }
          return (
            <Modal open hideTitle title={`Let ${device.name} use this computer?`} onClose={close}>
              <AllowPrompt
                key={`let-${device.node}`}
                approval={device}
                busy={busy}
                line={`Connects over ${engineWay(device)}, already in use.`}
                onAnswer={(yes, access) => void answer(yes, access)}
              />
              {error && (
                <p role="alert" className="chat-error">
                  {error}
                </p>
              )}
            </Modal>
          )
        })()}

      {everywhere && (
        <RemoveEverywhereDialog
          device={everywhere}
          onClose={() => setEverywhere(undefined)}
          onDone={() => {
            read()
            void refreshComputers()
          }}
        />
      )}

      {removing && (
        <RemoveDialog
          device={removing.device}
          side={removing.side}
          oneDirection={oneDirection(removing.device, removing.side)}
          busy={busy}
          onClose={() => setRemoving(undefined)}
          onRemove={(direction) => {
            const node = removing.device.node
            setRemoving(undefined)
            if (selected?.startsWith(`${node}:`)) setSelected(undefined)
            void action('netEngine.remove', direction ? { node, direction } : { node })
          }}
        />
      )}

      {revoking && (
        <Modal
          open
          title={`Remove ${revoking.name}?`}
          onClose={() => setRevoking(undefined)}
          footer={
            <button
              type="button"
              className="settings-btn devices-dialog-btn danger-fill"
              disabled={busy}
              onClick={() => {
                const node = revoking.node
                setRevoking(undefined)
                if (selected === node) setSelected(undefined)
                void action('bridge.revoke', { node })
              }}
            >
              Remove
            </button>
          }
        >
          <p>{revoking.name} will no longer connect to my other devices.</p>
        </Modal>
      )}

      {givingUp && (
        <Modal
          open
          title={`Give up connecting to ${unfinishedJoin?.name ?? 'the other computer'}?`}
          onClose={() => setGivingUp(false)}
          footer={
            <button
              type="button"
              className="settings-btn devices-dialog-btn danger-fill"
              disabled={busy}
              onClick={() => {
                setGivingUp(false)
                void action('net.join.abandon', {})
              }}
            >
              Give up
            </button>
          }
        >
          <p>
            {unfinishedJoin?.name ?? 'The other computer'} may already list this computer. If it does, remove it
            there.
          </p>
        </Modal>
      )}

      {granting && (
        <Modal
          open
          title={`Turn on Works on threads for ${granting.name}?`}
          onClose={() => setGranting(undefined)}
          footer={
            <button
              type="button"
              className="settings-btn devices-dialog-btn primary"
              disabled={busy}
              onClick={() => {
                const device = granting
                setGranting(undefined)
                void action('bridge.setCaps', { node: device.node, caps: [...device.caps, WORKS_ON_THREADS] })
              }}
            >
              Turn on
            </button>
          }
        >
          <div className="devices-dialog">
            <p>{workOnThreadsDisclosure(granting.name, granting.policy?.maxPermissionMode)}</p>
          </div>
        </Modal>
      )}

      {limits?.policy && (
        <DeviceLimitsDialog
          node={limits.node}
          name={limits.name}
          policy={limits.policy}
          onClose={() => setLimits(undefined)}
          onDone={reloadAll}
        />
      )}
      {recordDialog?.kind === 'undo' && (
        <UndoSetupDialog
          record={recordDialog.record}
          name={recordDialog.name}
          onClose={() => setRecordDialog(undefined)}
          onDone={reloadAll}
        />
      )}
      {updating && (
        <RemoteUpdateDialog
          node={updating.node}
          name={updating.name}
          version={updating.version}
          runs={nodes.find((item) => item.node === updating.node)?.version}
          onClose={() => {
            setUpdating(undefined)
            void refreshComputers()
          }}
        />
      )}
      {recordDialog?.kind === 'update' && (
        <UpdateRemoteDialog
          record={recordDialog.record}
          name={recordDialog.name}
          onClose={() => setRecordDialog(undefined)}
          onDone={reloadAll}
        />
      )}
    </>
  )
}


/**
 * Remove one row: on a pairing both ways, only that direction (the other row stays); otherwise the whole pairing.
 * Where networking can't end one direction yet, it says Remove ends both.
 */
function RemoveDialog({
  device,
  side,
  oneDirection,
  busy,
  onClose,
  onRemove
}: {
  device: NetEngineDevice
  side: EngineSide
  oneDirection: boolean
  busy: boolean
  onClose: () => void
  onRemove: (direction?: EngineSide) => void
}) {
  const both = engineSides(device).length === 2
  const name = device.name
  const title = !oneDirection
    ? `Remove ${name}?`
    : side === 'in'
      ? `Stop ${name} using this computer?`
      : `Stop using ${name}?`
  const line = oneDirection
    ? side === 'in'
      ? `It can no longer use this computer. This computer still uses it.`
      : `This computer stops using it. It can still use this computer.`
    : both
      ? 'Networking here can’t end one direction yet, so this removes both.'
      : side === 'in'
        ? 'It can no longer use this computer.'
        : 'This computer no longer uses it.'
  return (
    <Modal open title={title} onClose={onClose}>
      <p className="settings-muted" title="Remove it on the other computer too, or it keeps trying to connect.">
        {line}
      </p>
      <div className="devices-dialog-actions">
        <button type="button" className="settings-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="settings-btn danger-fill"
          disabled={busy}
          onClick={() => onRemove(oneDirection ? side : undefined)}
        >
          Remove
        </button>
      </div>
    </Modal>
  )
}

/** Removals by the device removed, in the order they were made. */
function removalGroups(
  removals: NetEngineRemoval[] | undefined
): Array<[string, NetEngineRemoval[]]> {
  const groups = new Map<string, NetEngineRemoval[]>()
  for (const item of removals ?? [])
    groups.set(item.removed, [...(groups.get(item.removed) ?? []), item])
  return [...groups]
}

/**
 * "Remove on all my hosts" (design D.1): each host where this computer is an owner and whose last list named the
 * device, with the grant id seen there; a host whose list did not name it says so and gets nothing.
 */
function RemoveEverywhereDialog({
  device,
  onClose,
  onDone
}: {
  device: NetEngineDevice
  onClose: () => void
  onDone: () => void
}) {
  const [hosts, setHosts] = useState<NetEngineRemovalHost[]>()
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void window.mousse.platformRequest
      .request<{ hosts: NetEngineRemovalHost[] }>('netEngine.removeEverywhere.plan', {
        node: device.node
      })
      .then((reply) => {
        if (!live) return
        setHosts(reply.hosts)
        setChosen(new Set(reply.hosts.filter((h) => h.grant !== null).map((h) => h.host)))
      })
      .catch((cause) => {
        if (live) setError(errorText(cause))
      })
    return () => {
      live = false
    }
  }, [device.node])
  const known = hosts?.filter((h) => h.grant !== null) ?? []
  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await window.mousse.platformRequest.request('netEngine.removeEverywhere', {
        node: device.node,
        hosts: known
          .filter((h) => chosen.has(h.host))
          .map((h) => ({ host: h.host, grant: h.grant }))
      })
      onDone()
      onClose()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  const label = (h: NetEngineRemovalHost) => h.name || h.host.slice(0, 8)
  return (
    <Modal open title={`Remove ${device.name} on all my hosts?`} onClose={onClose}>
      <div className="engine-dialog">
        {!hosts && !error && <p className="settings-muted">Reading your hosts…</p>}
        {hosts && !hosts.length && (
          <p className="settings-muted">This computer isn't an owner on any host.</p>
        )}
        {hosts && hosts.length > 0 && (
          <ul className="engine-hosts">
            {hosts.map((h) =>
              h.grant === null ? (
                <li key={h.host} className="settings-muted" data-host={h.host}>
                  Not known on {label(h)}
                </li>
              ) : (
                <li key={h.host} data-host={h.host}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(h.host)}
                      disabled={busy}
                      onChange={(event) => {
                        const next = new Set(chosen)
                        if (event.target.checked) next.add(h.host)
                        else next.delete(h.host)
                        setChosen(next)
                      }}
                    />
                    {label(h)}
                  </label>
                </li>
              )
            )}
          </ul>
        )}
        {error && (
          <p role="alert" className="chat-error">
            {error}
          </p>
        )}
        <div className="devices-dialog-actions">
          <button type="button" className="settings-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="settings-btn danger-fill"
            disabled={busy || !known.some((h) => chosen.has(h.host))}
            onClick={() => void confirm()}
          >
            Remove
          </button>
        </div>
      </div>
    </Modal>
  )
}
