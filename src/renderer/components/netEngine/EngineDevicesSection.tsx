import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AlertTriangle, Laptop, Monitor, MonitorSmartphone, Plus, RefreshCw, Smartphone, X } from '../../lib/icons'
import type { NetEngineDevice, NetEngineStatus } from '../../../shared/netEngine/local'
import { routeText } from '../../../shared/netEngine/routes'
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
import {
  engineAddresses,
  engineRow,
  engineWhere,
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
  const [adding, setAdding] = useState(false)
  const [addingPhone, setAddingPhone] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [picked, setPicked] = useState<string>()
  const [addressFor, setAddressFor] = useState<NetEngineDevice>()
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
    setAdding(true)
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
    const items: RowMenuItem[] = view.actions.map((kind) =>
      kind === 'access'
        ? accessItem(device.node)
        : kind === 'address'
          ? { label: 'Addresses…', action: 'engine-address', onSelect: () => setAddressFor(device) }
          : kind === 'retry'
            ? {
                label: 'Retry',
                action: 'engine-retry',
                onSelect: () => void action('netEngine.retry', { node: device.node })
              }
            : { label: 'Remove…', danger: true, action: 'engine-remove', onSelect: () => setRemoving(device) }
    )
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
              {view.warn && (
                <>
                  <AlertTriangle size={12} aria-hidden="true" />{' '}
                </>
              )}
              {view.line}
            </span>
            {view.how && (
              <>
                {' · '}
                <span title={view.howDetail}>{view.how}</span>
              </>
            )}
            {view.access && <>{' · '}{view.access}</>}
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
      selected === device.node && (
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
        <ReachSection
          status={status}
          onChanged={read}
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
          onAddPhone={
            canAddPhone
              ? () => {
                  setAdding(false)
                  setAddingPhone(true)
                }
              : undefined
          }
          onClose={() => setAdding(false)}
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

      {addressFor && status && (
        <AddressesDialog
          device={status.devices.find((device) => device.node === addressFor.node) ?? addressFor}
          ownRoutes={status.routes ?? []}
          anyKind={!!status.reach}
          onClose={() => setAddressFor(undefined)}
          onAdded={read}
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

/** Addresses: the other computer is dialled at these too, beside what the local network finds. */
function AddressesDialog({
  device,
  ownRoutes,
  anyKind,
  onClose,
  onAdded
}: {
  device: NetEngineDevice
  ownRoutes: string[]
  /** The helper takes every owner kind (protocol 1.1): tailnet, internet, a name, a tunnel URL. */
  anyKind: boolean
  onClose: () => void
  onAdded: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const own = ownRoutes.map(routeText).join(', ')
  const run = async (method: PlatformRequestMethod, params: unknown): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      await window.mousse.platformRequest.request(method, params)
      onAdded()
      return true
    } catch (cause) {
      setError(errorText(cause))
      return false
    } finally {
      setBusy(false)
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await run('netEngine.address.add', { node: device.node, address: text })) onClose()
  }
  return (
    <Modal open title={`Addresses for ${device.name}`} onClose={onClose}>
      <form className="devices-dialog" onSubmit={(event) => void submit(event)}>
        {!!device.addresses?.length && (
          <ul className="engine-address-list" aria-label="Addresses">
            {device.addresses.map((address) => (
              <li key={address}>
                <span title={address}>{routeText(address)}</span>
                <button
                  type="button"
                  className="settings-icon-btn"
                  aria-label={`Remove ${routeText(address)}`}
                  disabled={busy}
                  onClick={() => void run('netEngine.address.remove', { node: device.node, address })}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          className="settings-input"
          value={text}
          autoFocus
          placeholder={anyKind ? '100.101.7.2:47100 or https://…' : '192.168.1.20:47100'}
          aria-label="Address and port"
          title={own ? `Where ${device.name} can find it, such as this computer's own: ${own}` : undefined}
          onChange={(event) => setText(event.target.value)}
        />
        {error && (
          <p role="alert" className="chat-error">
            {error}
          </p>
        )}
        <div className="devices-dialog-actions">
          <button type="submit" className="settings-btn primary" disabled={busy || !text.trim()}>
            Add
          </button>
        </div>
      </form>
    </Modal>
  )
}
