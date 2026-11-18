import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSecretBinding } from './secretBinding'
import { isKeyName } from '../../shared/automationKeys'
import { SECRET_SERVICES, type SecretBinding } from '../../shared/secretServices'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ensurePrivateDirectory } from '../data/privateAcl'

/** Truthy authority with no usable destination: a lost or malformed record never becomes an unbound key. */
export const UNAVAILABLE_BINDING: SecretBinding = { origin: 'https://unavailable.invalid', service: 'an unavailable service', header: '', format: '' }

/** Safe words for the owner's card; never forward a parser or filesystem error. */
export class SecretBindingUnavailableError extends Error {
  constructor() {
    super('Bound, service unavailable. The binding could not be read. Nothing was stored.')
    this.name = 'SecretBindingUnavailableError'
  }
}

/**
 * Older vaults rewrite meta.json, so authority lives separately. A durable per-name guard is written first: losing
 * bindings.json still denies that key, while legacy unbound keys do not acquire a dependency on either JSON file.
 * Guards contain no values and older builds touch neither file. Delete the value before removing its guard.
 */
export class SecretBindings {
  private readonly path: string
  private readonly guards: string
  private readable = true
  private signature?: string
  private entries: Record<string, unknown> = Object.create(null)
  constructor(private readonly profileRoot: string) {
    this.path = join(profileRoot, 'secrets/bindings.json')
    this.guards = join(profileRoot, 'secrets/bound')
  }

  private read(): Record<string, unknown> {
    let signature: string | undefined
    try {
      const stat = lstatSync(this.path)
      signature = `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`
      if (signature === this.signature) return this.entries
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      this.readable = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      this.entries = this.readable ? parsed as Record<string, unknown> : Object.create(null)
    } catch (error) {
      this.readable = (error as NodeJS.ErrnoException).code === 'ENOENT'
      this.entries = Object.create(null)
    }
    // Cache parse/read failures too, until this file changes; guards still deny every affected name.
    this.signature = signature
    return this.entries
  }

  private guarded(name: string): boolean {
    try { lstatSync(join(this.guards, name)); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }

  get(name: string): SecretBinding | undefined {
    if (!isKeyName(name)) return undefined
    const entries = this.read()
    if (!Object.hasOwn(entries, name)) return this.guarded(name) ? UNAVAILABLE_BINDING : undefined
    const raw = entries[name]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return UNAVAILABLE_BINDING
    const entry = raw as Record<string, unknown>
    if (typeof entry.service === 'string') {
      const service = Object.hasOwn(SECRET_SERVICES, entry.service) ? SECRET_SERVICES[entry.service] : undefined
      return service ? { ...structuredClone(service), serviceId: entry.service } : UNAVAILABLE_BINDING
    }
    // Custom bindings have one fixed header and no model-selected paths or extra headers.
    if (typeof entry.origin !== 'string' || entry.header !== 'Authorization' || entry.format !== 'Bearer {}' ||
        Object.keys(entry).some(key => !['origin', 'header', 'format'].includes(key))) return UNAVAILABLE_BINDING
    try { return resolveSecretBinding({origin: entry.origin}) } catch { return UNAVAILABLE_BINDING }
  }

  set(name: string, binding: SecretBinding): void {
    const entries = this.read()
    if (!this.readable) throw new SecretBindingUnavailableError()
    const directory = join(this.profileRoot, 'secrets')
    ensurePrivateDirectory(directory)
    ensurePrivateDirectory(this.guards)
    atomicWriteJsonSync(join(this.guards, name), true, {mode: 0o600})
    const entry = binding.serviceId ? {service: binding.serviceId} : {origin: binding.origin, header: binding.header, format: binding.format}
    atomicWriteJsonSync(this.path, {...entries, [name]: entry}, {mode: 0o600})
    this.signature = undefined
  }

  delete(name: string): void {
    if (!isKeyName(name)) return
    const entries = {...this.read()}
    if (!this.readable) throw new SecretBindingUnavailableError()
    if (Object.hasOwn(entries, name)) {
      delete entries[name]
      atomicWriteJsonSync(this.path, entries, {mode: 0o600})
      this.signature = undefined
    }
    rmSync(join(this.guards, name), {force: true})
  }
}
