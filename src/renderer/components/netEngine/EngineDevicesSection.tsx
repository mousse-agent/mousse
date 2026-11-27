import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Laptop, Monitor, Plus, RefreshCw, Smartphone } from '../../lib/icons'
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
  connectedHere,
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
import type { RowMenuItem } from '../integrations/RowMenu'
import { MousseIdAccount } from '../MousseIdAccount'
import { AddPhoneDialog, EnrollmentRequestRow, useEnrollmentRequests } from '../MousseIdSection'
import { SettingsAdvanced, SettingsGroup, SettingsRow, Switch } from '../settings/SettingsRow'
import { DelayedLoader } from '../ui/DelayedLoader'
import { Modal } from '../ui/Modal'
import { AccessPanel, showsLevel } from './AccessPanel'
import { DevicesPane, type PaneEntry, type PaneNeed, type PaneStatus } from './DevicesPane'
import { AllowPrompt } from './AllowPrompt'
import { EnginePlusGroup } from './EnginePlusGroup'
import { LetDeviceInDialog, type LetDeviceInStart } from './LetDeviceInDialog'
import { UseComputerDialog } from './UseComputerDialog'
import { hasFeatures } from './ways'
import { computerUpdateWay } from './computerUpdate'
import { hostLabel, removalText, removalTitle } from './plusRows'
import {
  askedLine,
  directionOf,
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

/** A computer behind: Update (or Check again), and where to update it when not from here. */
type RowUpdate = { control?: ReactNode; hint?: ReactNode }

const PLATFORM_WORDS: Readonly<Record<string, string>> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

/**
 * Settings → Devices (design §7): one Networking switch, the devices on the left and the chosen one on the right
 * (which way the pairing works, its Mousse, its routes and its access here), then what this computer shares and how
 * other computers reach it. A pairing both ways is one device. The old networking's devices (paired before the
 * engine, and phones) sit in the same list and open the same Access panel.
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
  // The device whose detail shows; the first one until one is chosen.
  const [selected, setSelected] = useState<string>()
  // A device asked for from elsewhere in the app, scrolled into view once its row is there.
  const [picked, setPicked] = useState<string>()
  // `side` ends one direction of a pairing both ways; without one, Remove ends the whole pairing.
  const [removing, setRemoving] = useState<{ device: NetEngineDevice; side?: EngineSide }>()
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
    // Once it takes requests, its detail shows Update instead and this answer is not shown.
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
        setSelected(node)
        setPicked(node)
      }
    }
    pick()
    window.addEventListener('mousse:settings-device', pick)
    return () => window.removeEventListener('mousse:settings-device', pick)
  }, [])
  useEffect(() => {
    if (!picked) return
    // Its row may come with a later read.
    document.querySelector(`[data-device-node="${picked}"]`)?.scrollIntoView?.({ block: 'center' })
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

  /**
   * A computer that is behind gets its update in its detail: Update when this computer can update it (over SSH, or
   * through its app's update requests), otherwise one muted line saying where and why, with Check again when its app
   * may have opened since it last said.
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

  /** The detail's first section: its platform and Mousse version, and its update when it is behind. */
  const versionGroup = (name: string, device: Device | undefined, update: RowUpdate | undefined) => {
    const tag = device ? versionTag({ ...device, name }, current) : undefined
    const words = [device?.platform && (PLATFORM_WORDS[device.platform] ?? device.platform), device?.version].filter(Boolean)
    if (!words.length && !tag && !update) return null
    return (
      <SettingsGroup className="prov-editor-section">
        <SettingsRow
          title="Mousse"
          description={
            <span className="engine-row-line">
              {words.join(' · ')}
              {tag && (
                <>
                  {words.length > 0 && ' · '}
                  <span className={tag.label === 'Behind' ? 'settings-status-warn' : undefined} title={tag.detail}>
                    {tag.label}
                  </span>
                </>
              )}
              {update?.hint}
            </span>
          }
          control={update?.control}
        />
      </SettingsGroup>
    )
  }

  /** "Behind" for a row, with its version line as the tooltip. */
  const behindNeed = (name: string, device: Device | undefined): PaneNeed[] => {
    const tag = device ? versionTag({ ...device, name }, current) : undefined
    return tag?.label === 'Behind' ? [{ word: 'Behind', line: tag.detail }] : []
  }

  const block = (node: string) => (blocked: boolean) => void action('bridge.policy', { node, blocked })

  /** A pairing of the new networking: both its directions are one device. */
  const engineEntry = (device: NetEngineDevice): PaneEntry => {
    const sides = engineSides(device)
    const node = nodes.find((item) => item.node === device.node)
    const views = sides.map((side) => ({ side, view: engineSideRow(device, side) }))
    const problem = views.find(({ view }) => view.warn)?.view
    const first = views[0]!.view
    const connected = !problem && device.state === 'connected'
    const statusView: PaneStatus = problem
      ? { short: problem.line, line: problem.line, detail: problem.detail, tone: 'warn' }
      : device.state === 'offline'
        ? { short: 'Offline', line: first.line, detail: first.detail, tone: 'off' }
        : connected
          ? { short: 'Connected', line: 'Connected', tone: 'ok' }
          : { short: first.line, line: first.line, detail: first.detail, tone: 'off' }
    const relay = device.relay
    const removingNow = device.state === 'removing'

    // The menu: the missing direction first, then Retry, relays, and the ways to remove it.
    const menu: RowMenuItem[] = []
    const other = sides.length === 1 ? otherWayItem(device, sides[0]!) : undefined
    if (other)
      menu.push({
        ...other,
        action: 'engine-other-way',
        onSelect: () =>
          sides[0] === 'in' ? void action('netEngine.access.ask', { node: device.node }) : setLetting(device)
      })
    if (views.some(({ view }) => view.actions.includes('retry')))
      menu.push({ label: 'Retry', action: 'engine-retry', onSelect: () => void action('netEngine.retry', { node: device.node }) })
    // An allowed relay route can be taken back (Phase 3 §B.11), before Remove.
    if (sides.includes('out') && !removingNow)
      for (const destination of relay?.allowed ?? [])
        menu.push({
          label: `Stop using relay ${relayText(destination)}`,
          action: 'engine-relay-disallow',
          title: `${device.name} is no longer reached through this relay.`,
          onSelect: () => void action('netEngine.relay.disallow', { node: device.node, destination })
        })
    const removable = views.filter(({ view }) => view.actions.includes('remove')).map(({ side }) => side)
    if (removable.length && status?.identity)
      menu.push({
        label: 'Remove on all my hosts…',
        danger: true,
        action: 'engine-remove-everywhere',
        onSelect: () => setEverywhere(device)
      })
    if (removable.length === 2 && removable.every((side) => oneDirection(device, side)))
      for (const side of removable)
        menu.push({
          label: side === 'out' ? `Stop using ${device.name}…` : `Stop ${device.name} using this computer…`,
          danger: true,
          action: 'engine-remove',
          onSelect: () => setRemoving({ device, side })
        })
    else if (removable.length)
      menu.push({ label: 'Remove…', danger: true, action: 'engine-remove', onSelect: () => setRemoving({ device }) })

    // Notes that need this owner: an older Mousse, offered routes and relays, an ask for the other direction.
    const asked = askedLine(device)
    const notes = [
      device.olderApp && sides.includes('out') && (
        <SettingsRow
          key="older-out"
          title={<span className="settings-status-warn">{device.name} runs an older Mousse</span>}
          description={
            <span title={`Its own list keeps waiting for this computer. Update Mousse on ${device.name}, or remove it and connect again with “Also let ${device.name} use this computer” ticked.`}>
              Update it, or connect again with “Also let” ticked.
            </span>
          }
        />
      ),
      device.olderApp && device.direction === 'in' && (
        <SettingsRow
          key="older-in"
          title={<span className="settings-status-warn">{device.name} runs an older Mousse</span>}
          description={
            <span title={`It asks to be used from here as well, but only this computer decides that. To use ${device.name} from here, add it with Use another computer.`}>
              To use it from here, add it from this computer.
            </span>
          }
        />
      ),
      !!device.offered?.length && (
        <SettingsRow
          key="offered"
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
          key={`relay-${destination}`}
          title={relayOfferLine(device.name, destination)}
          control={
            <span className="engine-reach-control" data-mousse-decision="">
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                title="Not asked again for this relay."
                onClick={() => void action('netEngine.relay.dismiss', { node: device.node, destination })}
              >
                Not now
              </button>
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                title="Not dialled until you allow it."
                onClick={() => void action('netEngine.relay.allow', { node: device.node, destination })}
              >
                Allow
              </button>
            </span>
          }
        />
      )),
      asked && (
        <SettingsRow
          key="asked"
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
      )
    ].filter(Boolean)

    const relayNotes = sides.includes('out') && (relay?.stale || relay?.limit) && (
      <span className="engine-row-line">
        {relay?.stale && (
          <span className="settings-muted" title={RELAY_STALE_DETAIL(device.name)}>
            {RELAY_STALE_LINE}
          </span>
        )}
        {relay?.stale && relay?.limit && ' · '}
        {relay?.limit && (
          <span className="settings-muted" title={relayLimitDetail(relay.limit.callersMax)}>
            {relayLimitLine(relay.limit.callersMax)}
          </span>
        )}
      </span>
    )
    // The same notes as words for its row, so a device that needs this owner shows it unselected too.
    const needs: PaneNeed[] = [
      ...(device.offered?.length ? [{ word: 'New route', line: `${device.name} offered new ways to reach it` }] : []),
      ...(device.relay?.offered ?? []).map((destination) => ({
        word: 'New relay',
        line: relayOfferLine(device.name, destination)
      })),
      ...(asked && !asked.waiting
        ? [{ word: device.other?.asked === 'declined' ? 'Said Not now' : 'No answer', line: asked.line }]
        : []),
      ...(device.olderApp && (sides.includes('out') || device.direction === 'in')
        ? [{ word: 'Older Mousse', line: `${device.name} runs an older Mousse` }]
        : []),
      ...behindNeed(device.name, node)
    ]
    const how = connected ? engineWhere(device) : undefined
    const inView = views.find(({ side }) => side === 'in')?.view
    const showsAccess = !!inView?.actions.includes('access')
    // Its level, where the panel does not show it. The old networking calls a one-way pairing disconnected, as this
    // computer never dials it; the engine's own state says whether it is connected.
    const level =
      inView && !inView.warn && node && !showsLevel(node)
        ? accessShort({ ...node, connection: undefined }, { workOnThreads: true, shareBots: true })
        : undefined
    return {
      node: device.node,
      name: device.name,
      idTip: `Id ${device.shortId}`,
      icon: <Laptop size={16} />,
      direction: directionOf(sides),
      status: statusView,
      how,
      howDetail: engineAddresses(device),
      needs,
      menu,
      detail: (
        <>
          {notes.length > 0 && <SettingsGroup className="prov-editor-section">{notes}</SettingsGroup>}
          {versionGroup(device.name, node, updateView(device.name, node, undefined, sides.includes('out')))}
          {sides.includes('out') && !removingNow && (
            <SettingsGroup title="Routes" description={relayNotes || undefined} className="prov-editor-section">
              <RoutesPanel device={device} busy={busy} action={action} onChanged={reloadAll} />
            </SettingsGroup>
          )}
          {showsAccess && (
            <SettingsGroup title="Access here" description={level} className="prov-editor-section">
              <AccessPanel
                name={device.name}
                device={node}
                how={how}
                busy={busy}
                onChanged={reloadAll}
                onLimits={() => node && setLimits(node)}
                onBlock={block(device.node)}
                onRemove={() => setRemoving({ device, side: sides.length === 2 ? 'in' : undefined })}
              />
            </SettingsGroup>
          )}
        </>
      )
    }
  }

  /** A device of the old networking: a computer both ways, a phone using this computer. */
  const legacyEntry = (device: Device): PaneEntry => {
    const sides: EngineSide[] = device.kind === 'phone' ? ['in'] : ['out', 'in']
    const record = sshRecordFor(device, legacy.ssh)
    const state = legacyLine(device, now, { signedOut })
    const step = connectStep(device)
    const computer = sides.includes('out')
    const menu: RowMenuItem[] = [
      ...(computer && step && 'connect' in step
        ? [{ label: 'Connect', action: 'legacy-connect', onSelect: () => void action('bridge.connect', { node: device.node }) }]
        : []),
      ...(computer && record?.owner === 'managed' && !device.olderThanThis
        ? [
            {
              label: 'Update…',
              action: 'legacy-update',
              onSelect: () => setRecordDialog({ kind: 'update', record, name: device.name })
            }
          ]
        : []),
      ...(computer && record
        ? [{ label: 'Undo setup…', action: 'legacy-undo', onSelect: () => setRecordDialog({ kind: 'undo', record, name: device.name }) }]
        : []),
      ...(authority ? [{ label: 'Remove…', danger: true, action: 'legacy-remove', onSelect: () => setRevoking(device) }] : [])
    ]
    const connected = !state.warn && device.state === 'open' && connectedHere(device)
    const how = legacyHow(device)
    return {
      node: device.node,
      name: device.name,
      icon: device.kind === 'phone' ? <Smartphone size={16} /> : <Laptop size={16} />,
      direction: directionOf(sides),
      status: state.warn
        ? { short: state.line, line: state.line, detail: state.detail, tone: 'warn' }
        : connected
          ? { short: 'Connected', line: 'Connected', detail: state.detail, tone: 'ok' }
          : { short: state.line, line: state.line, detail: state.detail, tone: 'off' },
      how: connected ? how : undefined,
      // Signed out, devices that are not nearby are quiet.
      quiet: signedOut && device.state !== 'open',
      needs: computer ? behindNeed(device.name, device) : [],
      menu,
      detail: (
        <>
          {versionGroup(device.name, device, computer ? updateView(device.name, device, record, true) : undefined)}
          {device.policy && (
            <SettingsGroup
              title="Access here"
              description={!state.warn && !showsLevel(device) ? accessShort(device, switches) : undefined}
              className="prov-editor-section"
            >
              <AccessPanel
                name={device.name}
                device={device}
                how={how}
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
            </SettingsGroup>
          )}
        </>
      )
    }
  }

  const engineDevices = status?.on ? status.devices : []
  const engineNodes = new Set(engineDevices.map((device) => device.node))
  const oldDevices = legacyListed(legacy.devices).filter((device) => !engineNodes.has(device.node))
  const entries: PaneEntry[] = [...engineDevices.map(engineEntry), ...oldDevices.map(legacyEntry)]
  const held = heldDevices(legacy.devices).filter(({ device }) => !notNow.includes(device.node))
  const unfinishedJoin = v1 && !v1.self ? v1.unfinishedJoin : undefined
  const unfinishedSsh = legacy.ssh.filter((record) => record.phase !== 'done' && !record.node)
  const removals = status?.on ? removalGroups(status.removals) : []
  const removalAsks = status?.on ? (status.removalAsks ?? []) : []

  // What waits on this owner and belongs to no device in the list, above it.
  const notices = [
    status?.enabled && status.loginStart === 'ask' && (
      <SettingsRow
        key="login-start"
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
    ),
    unfinishedJoin && (
      <LegacyJoinRow
        key="join"
        name={unfinishedJoin.name}
        locked={locked}
        busy={busy}
        onRetry={(passphrase) => void action('net.join.retry', passphrase ? { passphrase } : {})}
        onGiveUp={() => setGivingUp(true)}
      />
    ),
    ...unfinishedSsh.map((record) => (
      <LegacyUnfinishedSshRow
        key={record.id}
        record={record}
        busy={busy}
        onUndo={() => setRecordDialog({ kind: 'undo', record, name: record.endpoint })}
      />
    )),
    ...enrollment.requests.map((request) => (
      <EnrollmentRequestRow
        key={request.id}
        row={request}
        busy={enrollment.busy}
        onDecide={(approve) => void enrollment.decide(request.id, approve)}
      />
    )),
    enrollment.error && (
      <p key="enrollment-error" role="alert" className="chat-error devices-error">
        {enrollment.error}
      </p>
    ),
    ...held.map(({ device, side }) => (
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
    )),
    ...removalAsks.map((ask) => (
      <p key={`${ask.host}-${ask.grant}`} className="settings-muted devices-note engine-ask" role="status">
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
    )),
    ...removals.map(([removed, items]) => {
      const title = removalTitle(items[0]!.name || removed.slice(0, 8), items)
      return (
        <SettingsRow
          key={removed}
          data-removal={removed}
          title={<span className={title.warn ? 'settings-status-warn' : undefined}>{title.line}</span>}
          description={
            <span className="engine-row-line">
              {items.map((item, index) => {
                const text = removalText(item)
                return (
                  <span key={item.id}>
                    {index > 0 && ' · '}
                    {hostLabel(item)}:{' '}
                    <span className={text.warn ? 'settings-status-warn' : undefined}>{text.line}</span>
                  </span>
                )
              })}
            </span>
          }
        />
      )
    })
  ].filter(Boolean)

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

      <div className="prov-page engine-devices" data-settings-anchor="devices-list">
        <div className="prov-toolbar">
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
            {canLetIn && (
              // Search's "Add a phone" lands here: Let a device in has the phone.
              <span data-settings-anchor="account-phones">
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
            )}
          </span>
          {(!notInBuild || switchOn) && (
            <span className="engine-group-actions engine-toolbar-end">
              <Switch
                checked={switchOn}
                label="Networking"
                disabled={busy}
                onChange={(next) => void toggleNetworking(next)}
              />
            </span>
          )}
        </div>
        {line && (
          <p className="settings-muted devices-note" role="status">
            {line}
          </p>
        )}
        {status?.sharedAccount && (
          <p className="devices-note">
            <span className="settings-status-warn" title={SHARED_ACCOUNT_DETAIL}>
              {SHARED_ACCOUNT_LINE}
            </span>
          </p>
        )}
        {notices.length > 0 && <SettingsGroup className="devices-group engine-group">{notices}</SettingsGroup>}
        {entries.length > 0 ? (
          <DevicesPane entries={entries} selected={selected} onSelect={setSelected} busy={busy} />
        ) : (
          switchOn && <p className="settings-muted devices-note">No devices yet.</p>
        )}
        {error && (
          <p role="alert" className="chat-error devices-error">
            {error}
          </p>
        )}
      </div>

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
          side={removing.side ?? engineSides(removing.device)[0]!}
          oneDirection={!!removing.side && oneDirection(removing.device, removing.side)}
          busy={busy}
          onClose={() => setRemoving(undefined)}
          onRemove={(direction) => {
            const node = removing.device.node
            setRemoving(undefined)
            if (!direction && selected === node) setSelected(undefined)
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
