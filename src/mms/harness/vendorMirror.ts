import { createHash } from 'node:crypto'
import { storedCliArgs, storedCliEnv } from '../providers/cliConfig'

/**
 * Launch settings and the sign-out flag live in each instance's config. Until the release after
 * this one, a vendor driver's own `settings.json` keeps a copy (the mirror), so an older Mousse
 * reads what the user set; its read side stays for good as the one-way import of settings an
 * older version left there.
 *
 * The instance remembers the vendor tuple it last confirmed written (`config.vendorMirror`, a
 * hash), which tells at the next start whether the instance, the vendor file or both changed
 * (`reconcileRow`).
 */

/** A field of the mirrored tuple. `signedOut` is `cliDisconnected` (Claude) or `disconnected` (Codex) in the vendor file. */
export type MirrorField = 'binaryPath' | 'args' | 'env' | 'signedOut'

/** The mirrored values; an absent field is the default (automatic lookup, none, signed in). */
export interface MirrorTuple {
  binaryPath?: string
  args?: string[]
  env?: Record<string, string>
  signedOut?: true
}

/**
 * The vendor file's copy of an instance's tuple, read from and written to the service's loaded
 * settings (never the file directly), so the service's own `save()` stays the file's one writer.
 */
export interface VendorMirror {
  readonly fields: readonly MirrorField[]
  /** `unreadable` while the service cannot read its settings file: nothing is reconciled then. */
  read(): MirrorTuple | 'unreadable'
  /**
   * Assigns the tuple on the service's current settings and saves them. Throws the service's
   * settings error before assigning anything, and any error of the save: a write that returns has
   * reached the file.
   */
  write(tuple: MirrorTuple): void
}

/** Every field: the built-in Claude Code and Codex instances. */
export const ALL_MIRROR_FIELDS: readonly MirrorField[] = Object.freeze(['binaryPath', 'args', 'env', 'signedOut'])
/** Launch settings only: Antigravity (its `signedIn` is real sign-in state, not a Mousse sign-out). */
export const LAUNCH_MIRROR_FIELDS: readonly MirrorField[] = Object.freeze(['binaryPath', 'args', 'env'])
/** The sign-out flag only: added Claude instances (their launch settings were always in config). */
export const SIGN_OUT_MIRROR_FIELDS: readonly MirrorField[] = Object.freeze(['signedOut'])

/** The instance-config key of each field. */
const CONFIG_KEY: Record<MirrorField, string> = { binaryPath: 'binaryPath', args: 'args', env: 'env', signedOut: 'signedOutInMousse' }

/** What the card calls each field when an older version's change was applied. */
const FIELD_LABEL: Record<MirrorField, string> = {
  binaryPath: 'executable path',
  args: 'launch arguments',
  env: 'environment variables',
  signedOut: 'sign-out'
}

export const MIRROR_MARKER_KEY = 'vendorMirror'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The tuple as both sides compare it: a cleared field (`null` in the instance, missing in the
 * vendor file), an empty list and a `false` flag are all absent, and malformed values are dropped
 * as the readers drop them.
 */
export function canonicalTuple(raw: { binaryPath?: unknown; args?: unknown; env?: unknown; signedOut?: unknown }, fields: readonly MirrorField[]): MirrorTuple {
  const tuple: MirrorTuple = {}
  for (const field of fields) {
    if (field === 'binaryPath') {
      if (typeof raw.binaryPath === 'string' && raw.binaryPath.trim()) tuple.binaryPath = raw.binaryPath.trim()
    } else if (field === 'args') {
      const args = storedCliArgs({ args: raw.args as string[] | undefined })
      if (args.length) tuple.args = args
    } else if (field === 'env') {
      const env = storedCliEnv({ env: isRecord(raw.env) ? (raw.env as Record<string, string>) : undefined })
      if (Object.keys(env).length) tuple.env = env
    } else if (raw.signedOut === true) tuple.signedOut = true
  }
  return tuple
}

/** The hash the marker stores: the canonical tuple, keys and variables in a fixed order. */
export function mirrorHash(tuple: MirrorTuple): string {
  const ordered: unknown[] = []
  if (tuple.args) ordered.push(['args', tuple.args])
  if (tuple.binaryPath) ordered.push(['binaryPath', tuple.binaryPath])
  if (tuple.env) ordered.push(['env', Object.entries(tuple.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])
  if (tuple.signedOut) ordered.push(['signedOut', true])
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

/** The instance's tuple, from its stored config. */
export function instanceTuple(config: Record<string, unknown> | undefined, fields: readonly MirrorField[]): MirrorTuple {
  const raw = config ?? {}
  return canonicalTuple({ binaryPath: raw.binaryPath, args: raw.args, env: raw.env, signedOut: raw.signedOutInMousse }, fields)
}

/** The stored marker, when the instance has one. */
export function storedMarker(config: Record<string, unknown> | undefined): string | undefined {
  const marker = config?.[MIRROR_MARKER_KEY]
  return typeof marker === 'string' && marker ? marker : undefined
}

/**
 * The tuple as instance config: every field explicit, a cleared launch key `null` and the flag
 * `true` or `false`, so "never set" (a missing key) stays distinguishable.
 */
export function tupleConfig(tuple: MirrorTuple, fields: readonly MirrorField[]): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const field of fields) {
    if (field === 'signedOut') config[CONFIG_KEY.signedOut] = tuple.signedOut === true
    else if (field === 'binaryPath') config.binaryPath = tuple.binaryPath ?? null
    else if (field === 'args') config.args = tuple.args ? [...tuple.args] : null
    else config.env = tuple.env ? { ...tuple.env } : null
  }
  return config
}

/** The fields the instance never set (no key in its config). A `null` or `false` is set. */
export function unsetFields(config: Record<string, unknown> | undefined, fields: readonly MirrorField[]): MirrorField[] {
  return fields.filter((field) => !Object.prototype.hasOwnProperty.call(config ?? {}, CONFIG_KEY[field]))
}

/** The fields whose values differ between two tuples. */
export function changedFields(a: MirrorTuple, b: MirrorTuple, fields: readonly MirrorField[]): MirrorField[] {
  return fields.filter((field) => mirrorHash(canonicalTuple(fieldOf(a, field), [field])) !== mirrorHash(canonicalTuple(fieldOf(b, field), [field])))
}

function fieldOf(tuple: MirrorTuple, field: MirrorField): Record<string, unknown> {
  return { [field]: tuple[field] }
}

export function fieldLabels(fields: readonly MirrorField[]): string {
  return fields.map((field) => FIELD_LABEL[field]).join(', ')
}

/**
 * What a start does for an instance with instance hash `instance`, vendor hash `vendor` and marker
 * `marker` (the vendor tuple as last confirmed written):
 * - `first_copy`: no marker yet (first start after the upgrade, or created while the vendor file
 *   was unreadable): copy the fields the instance never set, then continue as `finish_write` when
 *   the two still differ;
 * - `in_sync`: both sides agree (or a write stopped after the vendor file): record the marker;
 * - `finish_write`: only the instance moved (a write that stopped after the instance, a vendor
 *   file that refused it, or an add whose tuple differs): write the vendor file, then the marker;
 * - `older_changed`: only the vendor file moved (an older version changed it): take its values;
 * - `conflict`: both moved: keep the instance's and say so until the user picks or saves.
 */
export type ReconcileRow = 'first_copy' | 'in_sync' | 'finish_write' | 'older_changed' | 'conflict'

export function reconcileRow(instance: string, vendor: string, marker: string | undefined): ReconcileRow {
  if (marker === undefined) return 'first_copy'
  if (instance === vendor) return 'in_sync'
  if (vendor === marker) return 'finish_write'
  if (instance === marker) return 'older_changed'
  return 'conflict'
}

/** How a vendor service exposes its loaded settings to the mirror. */
export interface MirrorSource {
  /** The service's current settings object, read on every call: the service may replace it. */
  settings(): Record<string, unknown>
  /** Set while the settings file cannot be read: the mirror then neither reads nor writes. */
  settingsError(): string | undefined
  /** The service's own save: the one writer of its settings file. */
  save(): void
  /** The vendor file's key of the sign-out flag, for services that mirror it. */
  signedOutKey?: string
}

/** The vendor settings key each mirrored field is stored under. */
function vendorKey(field: MirrorField, source: MirrorSource): string {
  if (field !== 'signedOut') return field
  if (!source.signedOutKey) throw new Error('This settings file has no sign-out flag to mirror')
  return source.signedOutKey
}

/**
 * The mirror over a service's loaded settings: the only code that assigns the mirrored keys of a
 * vendor `settings.json` (`tests/harness/vendorMirror.test.ts` guards the services' sources).
 */
export function settingsMirror(fields: readonly MirrorField[], source: MirrorSource): VendorMirror {
  return {
    fields,
    read() {
      if (source.settingsError()) return 'unreadable'
      const settings = source.settings()
      return canonicalTuple({
        binaryPath: settings.binaryPath,
        args: settings.args,
        env: settings.env,
        signedOut: fields.includes('signedOut') ? settings[vendorKey('signedOut', source)] : undefined
      }, fields)
    },
    write(tuple) {
      const error = source.settingsError()
      if (error) throw new Error(error)
      const settings = source.settings()
      const next = canonicalTuple(tuple, fields)
      for (const field of fields) {
        const key = vendorKey(field, source)
        const value = next[field]
        if (value === undefined) delete settings[key]
        else settings[key] = Array.isArray(value) ? [...value] : isRecord(value) ? { ...value } : value
      }
      source.save()
    }
  }
}
