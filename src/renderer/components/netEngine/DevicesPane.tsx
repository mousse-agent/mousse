import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowLeftRight, ArrowRight } from '../../lib/icons'
import { RowMenu, type RowMenuItem } from '../integrations/RowMenu'
import { DIRECTION_WORDS, type EngineDirection } from './engineRows'
import '../../styles/providers.css'

/** A device's state in the list: a dot, and words only when it is not simply connected. */
export interface PaneStatus {
  /** A few words for the list. */
  short: string
  /** The whole line, for the detail's header. */
  line: string
  /** The fix or the reason, as a tooltip. */
  detail?: string
  tone: 'ok' | 'warn' | 'off'
}

/** One device: its row in the list and what its detail shows. */
export interface PaneEntry {
  node: string
  name: string
  /** Its id, as the name's tooltip in the detail. */
  idTip?: string
  icon: ReactNode
  direction: EngineDirection
  status: PaneStatus
  /** How it is connected now, after the state in the detail's header; the tooltip lists its addresses. */
  how?: string
  howDetail?: string
  /** Signed out, a device that is not nearby is quiet. */
  quiet?: boolean
  /** What waits on this owner in its detail, most pressing first: its row shows the first word. */
  needs?: PaneNeed[]
  menu: RowMenuItem[]
  /** The detail's sections. */
  detail: ReactNode
}

/** Something in a device's detail that waits on this owner: a word for its row, its whole line for the tooltip. */
export interface PaneNeed {
  word: string
  line: string
}

const DIRECTION_ICON = { both: ArrowLeftRight, out: ArrowRight, in: ArrowLeft } as const

/** "⇄ Both ways", "→ I use it", "← Uses this computer"; what it means is its tooltip. */
export function DirectionLabel({ direction }: { direction: EngineDirection }) {
  const Icon = DIRECTION_ICON[direction]
  const words = DIRECTION_WORDS[direction]
  return (
    <span className="engine-direction" title={words.detail} data-direction={direction}>
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      {words.label}
    </span>
  )
}

function StatusDot({ status }: { status: PaneStatus }) {
  return <span className={`engine-dot is-${status.tone}`} aria-hidden="true" />
}

/**
 * Settings → Devices: the devices on the left, the chosen one's detail on the right, as Providers lays out its own.
 * A row is chosen by click, or by Up, Down, Home and End once the list has focus; selection is a background fill.
 */
export function DevicesPane({
  entries,
  selected,
  onSelect,
  busy
}: {
  entries: PaneEntry[]
  selected: string | undefined
  onSelect: (node: string) => void
  busy: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)
  // Until one is picked, the page opens on the first device that needs something, else the first.
  const opened = useRef<string | undefined>(undefined)
  if (opened.current === undefined && entries.length)
    opened.current = (entries.find((entry) => entry.needs?.length) ?? entries[0]!).node
  const chosen =
    entries.find((entry) => entry.node === selected) ?? entries.find((entry) => entry.node === opened.current) ?? entries[0]
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = entries.findIndex((entry) => entry.node === chosen?.node)
    const next =
      event.key === 'ArrowDown'
        ? Math.min(index + 1, entries.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? entries.length - 1
              : undefined
    if (next === undefined || !entries[next]) return
    event.preventDefault()
    onSelect(entries[next].node)
    listRef.current?.querySelectorAll<HTMLButtonElement>('.prov-item-hit')[next]?.focus()
  }
  return (
    <div className="prov-pane engine-devices-pane">
      <div ref={listRef} className="prov-pane-list" role="group" aria-label="Devices" onKeyDown={move}>
        {entries.map((entry) => {
          const on = entry.node === chosen?.node
          return (
            <div
              key={entry.node}
              className={`prov-item engine-device-item${on ? ' is-selected' : ''}${entry.quiet ? ' is-off' : ''}`}
              data-device-node={entry.node}
            >
              <div className="prov-item-main">
                <button
                  type="button"
                  className="prov-item-hit"
                  aria-label={entry.name}
                  aria-pressed={on}
                  // One tab stop: the arrows move between rows.
                  tabIndex={on ? 0 : -1}
                  onClick={() => onSelect(entry.node)}
                />
                <span className="prov-logo engine-device-icon">{entry.icon}</span>
                <span className="prov-item-text">
                  <span className="prov-item-title">
                    <span className="prov-item-name">{entry.name}</span>
                  </span>
                  <span className="engine-device-line">
                    <StatusDot status={entry.status} />
                    {entry.status.tone !== 'ok' && (
                      <>
                        <span className={entry.status.tone === 'warn' ? 'settings-status-warn' : undefined} title={entry.status.detail}>
                          {entry.status.short}
                        </span>
                        {' · '}
                      </>
                    )}
                    {!!entry.needs?.length && (
                      <>
                        <span
                          className="settings-status-warn"
                          data-device-needs=""
                          title={entry.needs.map((need) => need.line).join('\n')}
                        >
                          {entry.needs[0]!.word}
                        </span>
                        {' · '}
                      </>
                    )}
                    <DirectionLabel direction={entry.direction} />
                  </span>
                </span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="prov-pane-editor">
        {chosen && (
          <div key={chosen.node} className="prov-editor engine-device-detail" data-device-detail={chosen.node}>
            <div className="engine-device-head">
              <span className="engine-device-icon">{chosen.icon}</span>
              <span className="engine-device-title">
                <span className="engine-device-name" title={chosen.idTip}>
                  {chosen.name}
                </span>
                <span className="engine-device-line">
                  <StatusDot status={chosen.status} />
                  <span className={chosen.status.tone === 'warn' ? 'settings-status-warn' : undefined} title={chosen.status.detail}>
                    {chosen.status.line}
                  </span>
                  {chosen.how && (
                    <>
                      {' · '}
                      <span title={chosen.howDetail}>{chosen.how}</span>
                    </>
                  )}
                  {' · '}
                  <DirectionLabel direction={chosen.direction} />
                </span>
              </span>
              {chosen.menu.length > 0 && <RowMenu label={`Actions for ${chosen.name}`} items={chosen.menu} disabled={busy} />}
            </div>
            {chosen.detail}
          </div>
        )}
      </div>
    </div>
  )
}
