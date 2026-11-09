import { useEffect, useId, useState } from 'react'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import { Check, ChevronRight, Copy } from '../../lib/icons'
import { Collapse } from '../ui/Collapse'
import { DRIVER_INFO, binarySourceLabel, formatVersion, instanceConfigOf } from './providerView'

/**
 * Read-only facts about a provider (where its executable is, its version, its account home, the
 * settings file it reads), kept out of the way: one collapsed, dimmed "Info" section at the bottom of
 * Advanced, one line per fact, with a copy button where the value is worth pasting elsewhere.
 */

export interface InfoRow {
  label: string
  value: string
  /** Offers a copy button (a path, an id). */
  copy?: boolean
  /** The value to copy and to show in full on hover, when `value` is shortened. */
  full?: string
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="settings-icon-btn prov-micro"
      title={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
      aria-label={`Copy ${label.toLowerCase()}`}
      onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

/** The "Info" section: closed until asked for, its rows muted until hovered or focused. */
export function ProviderInfoSection({ rows }: { rows: InfoRow[] }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  if (!rows.length) return null
  return (
    <section className="prov-info" data-testid="prov-info">
      <button type="button" className="prov-info-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={14} aria-hidden="true" className="prov-info-chevron" />
        Info
      </button>
      <Collapse open={open} as="dl" className="prov-info-rows" id={bodyId} itemCount={rows.length}>
        {rows.map((row) => (
          <div key={row.label} className="prov-info-row">
            <dt>{row.label}</dt>
            <dd title={row.full ?? row.value}>
              <span className="prov-info-value">{row.value}</span>
              {row.copy && <CopyValue label={row.label} value={row.full ?? row.value} />}
            </dd>
          </div>
        ))}
      </Collapse>
    </section>
  )
}

/** The facts of an agent entry: executable, version, where it came from, its home and settings file. */
export function agentInfoRows(snapshot: InstanceSnapshot): InfoRow[] {
  const rows: InfoRow[] = []
  const { binary } = snapshot
  if (binary?.path) rows.push({ label: 'Executable', value: binary.path, copy: true })
  else if (binary?.source === 'bundled') rows.push({ label: 'Executable', value: binarySourceLabel(binary) })
  else rows.push({ label: 'Executable', value: snapshot.checkedAt || snapshot.stale ? 'Not found' : 'Checking…' })
  const version = formatVersion(binary?.version)
  if (version) rows.push({ label: 'Version', value: version })
  if (binary?.path) rows.push({ label: 'Source', value: binarySourceLabel(binary) })
  const config = instanceConfigOf(snapshot)
  if (config && !DRIVER_INFO[snapshot.driver].bundled) {
    const hint = DRIVER_INFO[snapshot.driver].homeHint
    if (config.home === 'private') rows.push({ label: 'Account home', value: config.homePath ? `Private · ${config.homePath}` : 'Private', ...(config.homePath ? { copy: true, full: config.homePath } : {}) })
    else rows.push({ label: 'Account home', value: hint ? `Shared with terminal · ${hint}` : 'Shared with terminal' })
  }
  if (snapshot.settingsFile) rows.push({ label: 'Settings file', value: snapshot.settingsFile.path, copy: true })
  rows.push({ label: 'ID', value: snapshot.instanceId, copy: true })
  return rows
}

/** The facts of a model API entry: how it signs in and its id. */
export function apiInfoRows(snapshot: InstanceSnapshot): InfoRow[] {
  return [
    ...(snapshot.auth.methodLabel ? [{ label: 'Sign-in', value: snapshot.auth.methodLabel }] : []),
    ...(snapshot.models.refreshedAt ? [{ label: 'Models listed', value: new Date(snapshot.models.refreshedAt).toLocaleString() }] : []),
    { label: 'ID', value: snapshot.instanceId, copy: true }
  ]
}
