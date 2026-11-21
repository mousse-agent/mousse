import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Laptop, Monitor, MonitorSmartphone, Plus, RefreshCw, Smartphone } from '../../lib/icons'
import type {
  NetEngineDevice,
  NetEngineRemoval,
  NetEngineRemovalHost,
  NetEngineStatus
} from '../../../shared/netEngine/local'
import { relayText, routeText } from '../../../shared/netEngine/routes'
import type { PlatformRequestMethod } from '../../../shared/platform'
import type { SshRecordView } from '../../../shared/net/local'
import { refreshComputers, useComputers } from '../../lib/computers'
import {
  canWorkOnThreads,
  connectStep,
  heldDevices,
  joinErrorWords,
  passLapsed,
  sshRecordFor,
  workOnThreadsDisclosure,
  worksOnThreads,
  WORKS_ON_THREADS,
  type Device
} from '../../lib/netDevices'
import { phonesBlocked } from '../../lib/plusEnrollment'
import { takePendingDevice } from '../../lib/settingsNavigation'
import { useAppStore } from '../../stores/appStore'
import { useMousseIdAvailable, useMousseIdStore } from '../../stores/mousseIdStore'
import { DeviceLimitsDialog } from '../devices/DeviceLimitsDialog'
import { EditorSshSettings } from '../devices/EditorSshSettings'
import { UndoSetupDialog, UpdateRemoteDialog } from '../devices/SshRecordDialogs'
import { WorkHereRow } from '../devices/WorkHereRow'
import { errorText } from '../devices/useDaemonCall'
import { RowMenu, type RowMenuItem } from '../integrations/RowMenu'
import { MousseIdAccount } from '../MousseIdAccount'
import { AddPhoneDialog, EnrollmentRequestRow, useEnrollmentRequests } from '../MousseIdSection'
import { SettingsAdvanced, SettingsGroup, SettingsRow, Switch } from '../settings/SettingsRow'
import { Modal } from '../ui/Modal'
import { AccessPanel } from './AccessPanel'
import { AddEngineDeviceDialog } from './AddEngineDeviceDialog'
import { EnginePlusGroup } from './EnginePlusGroup'
import { hostLabel, removalText, removalTitle } from './plusRows'
import {
  engineAddresses,
  engineRow,
  engineWhere,
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
import { CodeEntry } from './SendLinkParts'
import { ReachSection } from './ReachSection'
import { RoutesPanel } from './RoutesPanel'
import '../../styles/devices.css'
import './engine.css'

/** Reads `netEngine.status` for this window's profile, again whenever the daemon says it changed. */
export function useEngineStatus(): {
  status: NetEngineStatus | undefined
  read: () => void
} {
  const profileId = useAppStore((state) => state.profileId)
  const [status, setStatus] = useState<NetEngineStatus>()
  const read = useCallback(() => {
    const profile = useAppStore.getState().profileId
    void window.mousse.platformRequest
      .request<NetEngineStatus>('netEngine.status', {})
      .then((value) => {
        if (useAppStore.getState().profileId === profile) setStatus(value)
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    setStatus(undefined)
    read()
    const off = window.mousse?.netEngine?.onChanged?.((change) => {
      if (!change.profileId || change.profileId === useAppStore.getState().profileId) read()
    })
    return () => off?.()
  }, [profileId, read])
  return { status, read }
}

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
  name: string
  icon: ReactNode
  line: string
  detail?: string
  warn?: boolean
  /** How it is connected now; the tooltip lists its addresses. */
  how?: string
  howDetail?: string
  access?: string
  /** Relay notes after the line. */
  extra?: ReactNode
  items: RowMenuItem[]
  quiet?: boolean
}

/**
 * Settings → Devices (design §7): one Networking switch, one list of my devices, what this computer shares, and
 * how other computers reach it. Engine pairings and the old networking's devices (paired before the engine, and
 * phones) sit in the same list and open the same Access panel.
 */
export function EngineDevicesSection() {
  const { status, read } = useEngineStatus()
  const legacy = useLegacyNet()
  const v1 = legacy.status
  const v1On = legacyOn(v1)
  const v1Ready = v1On && !!v1?.self && v1?.keystore === 'unlocked'
  const { devices: nodes } = useComputers(!!status?.on || v1Ready)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState<'choose' | 'link' | 'cloudflare'>()
  const [addingPhone, setAddingPhone] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [picked, setPicked] = useState<string>()
  const [removing, setRemoving] = useState<NetEngineDevice>()
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
  const [everywhere, setEverywhere] = useState<NetEngineDevice>()
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
        setSelected(node)
      }
    }
    pick()
    window.addEventListener('mousse:settings-device', pick)
    return () => window.removeEventListener('mousse:settings-device', pick)
  }, [])
  useEffect(() => {
    if (!picked) return
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
  // Add device turns networking on first; nothing listens until then.
  const addDevice = async () => {
    if (status && !status.enabled && !notInBuild) await action('netEngine.enable', {})
    setAdding('choose')
  }
  const canAddPhone = mousseId && !phoneBlocked
  const canAdd = !notInBuild || canAddPhone

  const toggle = (node: string) => setSelected((current) => (current === node ? undefined : node))
  const accessItem = (node: string): RowMenuItem => ({
    label: selected === node ? 'Hide access' : 'Access',
    action: 'device-access',
    onSelect: () => toggle(node)
  })

  const engineView = (device: NetEngineDevice): RowView => {
    const view = engineRow(device)
    const node = nodes.find((item) => item.node === device.node)
    const connected = view.line === 'Connected'
    const relay = device.relay
    // An allowed relay route can be taken back from the row (Phase 3 §B.11), before Remove.
    const relayItems: RowMenuItem[] =
      device.state === 'removing'
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
          ? []
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
                ...(status?.identity
                  ? [
                      {
                        label: 'Remove on all my hosts…',
                        danger: true,
                        action: 'engine-remove-everywhere',
                        onSelect: () => setEverywhere(device)
                      }
                    ]
                  : []),
                { label: 'Remove…', danger: true, action: 'engine-remove', onSelect: () => setRemoving(device) }
              ]
    )
    if (!view.actions.includes('remove')) items.push(...relayItems)
    // Its routes show in the open row; a device with no Access panel opens for them alone.
    if (!view.actions.includes('access'))
      items.unshift({
        label: selected === device.node ? 'Hide routes' : 'Routes',
        action: 'device-routes',
        onSelect: () => toggle(device.node)
      })
    return {
      key: device.node,
      name: device.name,
      icon: <Laptop size={16} />,
      line: view.line,
      detail: view.detail,
      warn: view.warn,
      how: connected ? engineWhere(device) : undefined,
      howDetail: engineAddresses(device),
      access: view.warn ? undefined : accessShort(node, { workOnThreads: true, shareBots: true }),
      extra: (
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
      ),
      items
    }
  }

  const legacyView = (device: Device): RowView => {
    const record = sshRecordFor(device, legacy.ssh)
    const state = legacyLine(device, now, { signedOut })
    const step = connectStep(device)
    const items: RowMenuItem[] = [
      ...(device.policy ? [accessItem(device.node)] : []),
      ...(step && 'connect' in step
        ? [
            {
              label: 'Connect',
              action: 'legacy-connect',
              onSelect: () => void action('bridge.connect', { node: device.node })
            }
          ]
        : []),
      ...(record?.owner === 'managed'
        ? [
            {
              label: 'Update…',
              action: 'legacy-update',
              onSelect: () => setRecordDialog({ kind: 'update', record, name: device.name })
            }
          ]
        : []),
      ...(record
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
      key: device.node,
      name: device.name,
      icon: device.kind === 'phone' ? <Smartphone size={16} /> : <Laptop size={16} />,
      line: state.line,
      detail: state.detail,
      warn: state.warn,
      access: state.warn ? undefined : accessShort(device, switches),
      items,
      // Signed out, devices that are not nearby are quiet.
      quiet: signedOut && device.state !== 'open'
    }
  }

  const row = (view: RowView, idTip?: string) => {
    const open = selected === view.key
    return (
      <SettingsRow
        key={view.key}
        data-device-node={view.key}
        className={[open ? 'engine-row-selected' : '', picked === view.key ? 'devices-row-picked' : '']
          .filter(Boolean)
          .join(' ') || undefined}
        disabled={view.quiet}
        leading={view.icon}
        title={idTip ? <span title={idTip}>{view.name}</span> : view.name}
        description={
          <span className="engine-row-line">
            <span className={view.warn ? 'settings-status-warn' : undefined} title={view.detail}>
              {view.line}
            </span>
            {view.how && (
              <>
                {' · '}
                <span title={view.howDetail}>{view.how}</span>
              </>
            )}
            {view.access && <>{' · '}{view.access}</>}
            {view.extra}
          </span>
        }
        control={
          view.items.length ? (
            <RowMenu label={`Actions for ${view.name}`} items={view.items} disabled={busy} />
          ) : undefined
        }
      />
    )
  }

  const block = (node: string) => (blocked: boolean) => void action('bridge.policy', { node, blocked })

  const engineDevices = status?.on ? status.devices : []
  const engineRows = engineDevices.flatMap((device) => {
    const view = engineView(device)
    const node = nodes.find((item) => item.node === device.node)
    return [
      row(view, `Id ${device.shortId}`),
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
      selected === device.node && (
        <RoutesPanel
          key={`${device.node}-routes`}
          device={device}
          busy={busy}
          action={action}
          onChanged={reloadAll}
        />
      ),
      selected === device.node && engineRow(device).actions.includes('access') && (
        <AccessPanel
          key={`${device.node}-access`}
          name={device.name}
          device={node}
          how={view.how}
          busy={busy}
          onChanged={reloadAll}
          onLimits={() => node && setLimits(node)}
          onBlock={block(device.node)}
          onRemove={() => setRemoving(device)}
        />
      )
    ]
  })
  const engineNodes = new Set(engineDevices.map((device) => device.node))
  const oldDevices = legacyListed(legacy.devices).filter((device) => !engineNodes.has(device.node))
  const oldRows = oldDevices.flatMap((device) => [
    row(legacyView(device)),
    selected === device.node && (
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
  const empty =
    !engineRows.length &&
    !oldRows.length &&
    !held.length &&
    !unfinishedJoin &&
    !unfinishedSsh.length &&
    !enrollment.requests.length

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
        title="My devices"
        icon={MonitorSmartphone}
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
            {canAdd && (
              // Search's "Add a phone" lands here: Add device has the phone under More ways.
              <span data-settings-anchor="account-phones">
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy}
                  onClick={() => void addDevice()}
                >
                  <Plus size={14} aria-hidden="true" />
                  Add device
                </button>
              </span>
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
        {unfinishedJoin && (
          <LegacyJoinRow
            name={unfinishedJoin.name}
            locked={locked}
            busy={busy}
            onRetry={(passphrase) => void action('net.join.retry', passphrase ? { passphrase } : {})}
            onGiveUp={() => setGivingUp(true)}
          />
        )}
        {engineRows}
        {oldRows}
        {unfinishedSsh.map((record) => (
          <LegacyUnfinishedSshRow
            key={record.id}
            record={record}
            busy={busy}
            onUndo={() => setRecordDialog({ kind: 'undo', record, name: record.endpoint })}
          />
        ))}
        {status?.on &&
          status.removalAsks?.map((ask) => (
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
        {status?.on &&
          removalGroups(status.removals).map(([removed, items]) => {
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
        {empty && switchOn && <p className="settings-muted devices-note">No devices yet.</p>}
        {error && (
          <p role="alert" className="chat-error devices-error">
            {error}
          </p>
        )}
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
          onSendLink={() => setAdding('link')}
          onCloudflareSetup={() => setAdding('cloudflare')}
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

      {adding && (
        <AddEngineDeviceDialog
          status={status}
          initial={adding}
          onAddPhone={
            canAddPhone
              ? () => {
                  setAdding(undefined)
                  setAddingPhone(true)
                }
              : undefined
          }
          onClose={() => setAdding(undefined)}
        />
      )}
      {addingPhone && <AddPhoneDialog onClose={() => setAddingPhone(false)} />}

      {linkToEnter && !adding && (
        <AddEngineDeviceDialog
          status={status}
          initial="enter"
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
        <Modal open title={`Remove ${removing.name}?`} onClose={() => setRemoving(undefined)}>
          <p
            className="settings-muted"
            title="Remove it on the other computer too, or it keeps trying to connect."
          >
            It can no longer use this computer.
          </p>
          <div className="devices-dialog-actions">
            <button type="button" className="settings-btn" onClick={() => setRemoving(undefined)}>
              Cancel
            </button>
            <button
              type="button"
              className="settings-btn danger-fill"
              disabled={busy}
              onClick={() => {
                const node = removing.node
                setRemoving(undefined)
                if (selected === node) setSelected(undefined)
                void action('netEngine.remove', { node })
              }}
            >
              Remove
            </button>
          </div>
        </Modal>
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
