import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, Laptop, Network, Plus, X } from '../../lib/icons'
import type { NetEngineDevice, NetEngineStatus } from '../../../shared/netEngine/local'
import { relayText, routeText } from '../../../shared/netEngine/routes'
import type { PlatformRequestMethod } from '../../../shared/platform'
import { refreshComputers, useComputers } from '../../lib/computers'
import { useAppStore } from '../../stores/appStore'
import { DevicePresetRow } from '../devices/DevicePresetRow'
import { WorkHereRow } from '../devices/WorkHereRow'
import { errorText } from '../devices/useDaemonCall'
import { RowMenu, type RowMenuItem } from '../integrations/RowMenu'
import { SettingsGroup, SettingsRow, Switch } from '../settings/SettingsRow'
import { Modal } from '../ui/Modal'
import { AddEngineDeviceDialog } from './AddEngineDeviceDialog'
import {
  engineRow,
  engineWhere,
  relayOfferLine,
  RELAY_LIMIT_DETAIL,
  RELAY_LIMIT_LINE,
  RELAY_STALE_DETAIL,
  RELAY_STALE_LINE,
  SHARED_ACCOUNT_DETAIL,
  SHARED_ACCOUNT_LINE,
  type EngineRowAction
} from './engineRows'
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

/** What the switch row says under its title while the engine is not simply on. */
function helperLine(status: NetEngineStatus): string | undefined {
  if (status.paused) return status.paused
  if (status.helper.text) return status.helper.text
  if (
    status.enabled &&
    (status.helper.state === 'starting' || status.helper.state === 'restarting')
  )
    return 'Starting…'
  return undefined
}

/**
 * Settings → Devices for the new networking (design §7): its switch, the paired computers with their state (§5.2),
 * and Add device. A build without the helper shows nothing unless the switch was turned on.
 */
export function EngineDevicesSection() {
  const { status, read } = useEngineStatus()
  const { devices: nodes } = useComputers(!!status?.on)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [addressFor, setAddressFor] = useState<NetEngineDevice>()
  const [removing, setRemoving] = useState<NetEngineDevice>()
  // A `mousse://pair` link that opened Mousse opens Enter link with it.
  const offered = useOfferedPairLink()
  const [linkToEnter, setLinkToEnter] = useState<string>()
  useEffect(() => {
    if (!offered || !status) return
    const link = takeOfferedPairLink()
    if (link) setLinkToEnter(link)
  }, [offered, status])

  const action = async (method: PlatformRequestMethod, params: unknown): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      await window.mousse.platformRequest.request(method, params)
      return true
    } catch (cause) {
      setError(errorText(cause))
      return false
    } finally {
      setBusy(false)
      read()
      void refreshComputers()
    }
  }

  if (!status || (status.helper.state === 'not_in_build' && !status.enabled)) return null
  const line = helperLine(status)

  const row = (device: NetEngineDevice) => {
    const view = engineRow(device)
    const open = selected === device.node
    const node = nodes.find((item) => item.node === device.node)
    const relay = device.relay
    // An allowed relay route can be taken back from the row (Phase 3 §B.11), before Remove.
    const relayItems: RowMenuItem[] =
      device.state === 'removing'
        ? []
        : (relay?.allowed ?? []).map((destination) => ({
            label: `Stop using relay ${relayText(destination)}`,
            action: 'engine-relay-disallow',
            title: `${device.name} is no longer dialled through this relay.`,
            onSelect: () =>
              void action('netEngine.relay.disallow', { node: device.node, destination })
          }))
    const menuItem = (kind: EngineRowAction): RowMenuItem =>
      kind === 'access'
        ? {
            label: open ? 'Hide access' : 'Access',
            action: 'engine-access',
            onSelect: () => setSelected(open ? undefined : device.node)
          }
        : kind === 'address'
          ? {
              label: 'Add address…',
              action: 'engine-address',
              onSelect: () => setAddressFor(device)
            }
          : kind === 'retry'
            ? {
                label: 'Retry',
                action: 'engine-retry',
                onSelect: () => void action('netEngine.retry', { node: device.node })
              }
            : {
                label: 'Remove…',
                danger: true,
                action: 'engine-remove',
                onSelect: () => setRemoving(device)
              }
    const items: RowMenuItem[] = view.actions.flatMap((kind) =>
      kind === 'remove' ? [...relayItems, menuItem(kind)] : [menuItem(kind)]
    )
    if (!view.actions.includes('remove')) items.push(...relayItems)
    return [
      <SettingsRow
        key={device.node}
        data-device-node={device.node}
        className={open ? 'engine-row-selected' : undefined}
        leading={<Laptop size={16} />}
        title={device.name}
        description={
          <span className="engine-row-line">
            <span
              className="engine-row-id"
              title="The start of its id, to tell computers of one name apart"
            >
              {device.shortId}
            </span>
            {' · '}
            <span className={view.warn ? 'settings-status-warn' : undefined} title={view.detail}>
              {view.warn && (
                <>
                  <AlertTriangle size={12} aria-hidden="true" />{' '}
                </>
              )}
              {view.line}
            </span>
            {' · '}
            <span title={device.addresses?.map(routeText).join(', ')}>
              {engineWhere(device)}
            </span>
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
                <span className="settings-muted" title={RELAY_LIMIT_DETAIL}>
                  {RELAY_LIMIT_LINE}
                </span>
              </>
            )}
          </span>
        }
        control={
          items.length ? (
            <RowMenu label={`Actions for ${device.name}`} items={items} disabled={busy} />
          ) : undefined
        }
      />,
      !!device.offered?.length && (
        <SettingsRow
          key={`${device.node}-offered`}
          indent
          title={`Addresses ${device.name} offered`}
          description={
            <span title="Not dialled until you tap Use.">
              {device.offered.map(routeText).join(', ')}
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
      ...(relay?.offered ?? []).map((destination) => (
        <SettingsRow
          key={`${device.node}-relay-${destination}`}
          indent
          title={relayOfferLine(device.name, destination)}
          control={
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
          }
        />
      )),
      open && node && (
        <DevicePresetRow
          key={`${device.node}-access`}
          device={node}
          onChanged={() => void refreshComputers()}
        />
      )
    ]
  }

  return (
    <>
      <SettingsGroup
        anchor="devices-engine"
        title="New networking (LAN)"
        icon={Network}
        className="devices-group engine-group"
        description={
          status.sharedAccount ? (
            <span className="settings-status-warn" title={SHARED_ACCOUNT_DETAIL}>
              {SHARED_ACCOUNT_LINE}
            </span>
          ) : undefined
        }
        action={
          <span className="engine-group-actions">
            {status.on && (
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                onClick={() => setAdding(true)}
              >
                <Plus size={14} aria-hidden="true" />
                Add device
              </button>
            )}
            <Switch
              checked={status.enabled}
              label="New networking (LAN)"
              disabled={busy}
              onChange={(next) => void action(next ? 'netEngine.enable' : 'netEngine.disable', {})}
            />
          </span>
        }
      >
        {line && (
          <p className="settings-muted devices-note" role="status">
            {line}
          </p>
        )}
        {status.enabled && status.loginStart === 'ask' && (
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
        {/* v1's Devices group has this switch while v1 is on; while it is off, this group does. */}
        {status.workOnThreads !== undefined && (
          <WorkHereRow
            on={status.workOnThreads}
            busy={busy}
            onChange={(next) => void action('netEngine.workOnThreads', { enabled: next })}
          />
        )}
        {status.on && status.devices.flatMap(row)}
        {status.on && !status.devices.length && (
          <p className="settings-muted devices-note">No computers yet.</p>
        )}
        {error && (
          <p role="alert" className="chat-error devices-error">
            {error}
          </p>
        )}
      </SettingsGroup>

      {status.on && (status.reach || status.relays) && (
        <ReachSection status={status} onChanged={read} />
      )}

      {adding && <AddEngineDeviceDialog status={status} onClose={() => setAdding(false)} />}

      {linkToEnter && !adding && (
        <AddEngineDeviceDialog
          status={status}
          initial="enter"
          initialLink={linkToEnter}
          onClose={() => setLinkToEnter(undefined)}
        />
      )}

      {/* A Send link join repeated by Retry or after a restart asks for the code here. */}
      {!adding &&
        !linkToEnter &&
        (() => {
          const waiting = status.joins?.find((join) => join.needsCode && join.node)
          if (!waiting) return null
          const device = status.devices.find((item) => item.node === waiting.node)
          return (
            <Modal open title={device ? `Pair with ${device.name}` : 'Enter link'} onClose={() => undefined}>
              <CodeEntry join={waiting} />
            </Modal>
          )
        })()}

      {addressFor && (
        <AddAddressDialog
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
    </>
  )
}

/** Add address: the other computer is dialled at this address too, beside what the local network finds. */
function AddAddressDialog({
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
    <Modal open title={`Add address for ${device.name}`} onClose={onClose}>
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
                  onClick={() =>
                    void run('netEngine.address.remove', { node: device.node, address })
                  }
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
          title={own ? `This computer's own address: ${own}` : undefined}
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
