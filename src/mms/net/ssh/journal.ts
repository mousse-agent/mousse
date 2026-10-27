import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { NodeId } from '../../../shared/net'
import type { InviteId } from '../../../shared/net'
import type { SshOwner, SshSetupPhase } from '../../../shared/net/local'
import { parseSshEndpoint, sshApprovalsPath, type SshApproval } from '../transports/ssh'

export type StepState = 'pending' | 'done' | 'failed' | 'unknown' | 'skipped'

/**
 * One step of a setup, recorded twice: an intent (`pending`) is on disk before the step's first
 * change, and a completion once the command returned. A crash between the two leaves a `pending`
 * step that names the resource and what was there before, so Undo can inspect and reverse it and
 * Retry can reconcile it from the machine's own state.
 */
export interface StepRecord {
  step: string
  resource: string
  before?: unknown
  startedAt: number
  state: StepState
  after?: unknown
  result?: string
}

export interface SshManifest {
  /** Random; never derived from the host, alias, user or port, so renaming the alias orphans nothing. */
  id: string
  endpoint: string
  resolved: { hostname: string; port: number; user: string }
  name: string
  daemonPort: number
  home: string
  node?: NodeId
  inviteId?: InviteId
  phase: SshSetupPhase
  error?: string
  cli: {
    owner: Exclude<SshOwner, 'none'>
    version?: string
    /** The absolute path every remote `mousse-cli` call uses. */
    path: string
    installDir?: string
    /** The previous launcher text, when a Mousse launcher was replaced. */
    launcherBefore?: string | null
  }
  service: { owner: Exclude<SshOwner, 'none'>; unitPath?: string; unitExistedBefore: boolean }
  lingerBefore?: 'yes' | 'no'
  lingerSkipped?: boolean
  /** The host's previous `ssh` add-on row (`null`: there was none). */
  transportBefore?: { enabled: boolean; settings: unknown } | null
  hostKey: { hostname: string; fingerprint: string }
  steps: StepRecord[]
  createdAt: number
  updatedAt: number
}

export const MANIFEST_ID = /^ssh_[A-Za-z0-9_-]{16,32}$/u

export function newManifestId(): string {
  return `ssh_${randomBytes(12).toString('base64url')}`
}

/** Writes through a temporary file and a rename, and syncs the file first. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2))
    await handle.sync()
  } finally {
    await handle.close()
  }
  // Windows refuses to replace a file a reader has open for a moment; a short retry is enough.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < 20 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((resolve) => setTimeout(resolve, 15))
        continue
      }
      await rm(temporary, { force: true })
      throw error
    }
  }
}

export class ManifestStore {
  constructor(private readonly profileDir: string) {}
  directory(): string {
    return join(this.profileDir, 'net', 'ssh')
  }
  private file(id: string): string {
    return join(this.directory(), `${id}.json`)
  }
  async read(id: string): Promise<SshManifest | undefined> {
    if (!MANIFEST_ID.test(id)) return undefined
    try {
      const value = JSON.parse(await readFile(this.file(id), 'utf8')) as SshManifest
      return value && value.id === id && parseSshEndpoint(value.endpoint) ? value : undefined
    } catch {
      return undefined
    }
  }
  async list(): Promise<SshManifest[]> {
    let names: string[]
    try {
      names = await readdir(this.directory())
    } catch {
      return []
    }
    const all = await Promise.all(
      names
        .filter((name) => name.endsWith('.json') && MANIFEST_ID.test(name.slice(0, -5)))
        .map((name) => this.read(name.slice(0, -5)))
    )
    return all.filter((value): value is SshManifest => !!value)
  }
  async write(manifest: SshManifest): Promise<void> {
    manifest.updatedAt = Date.now()
    await writeJsonAtomic(this.file(manifest.id), manifest)
  }
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true })
  }
}

export interface ApprovalRow extends SshApproval {
  /** The host name the known_hosts line is keyed by, so a line is removed only when nothing else uses it. */
  hostname?: string
}

/** `approvals.json` is written only here, by this computer's own owner-facing methods. */
export class ApprovalStore {
  constructor(private readonly profileDir: string) {}
  async read(): Promise<Record<string, ApprovalRow>> {
    try {
      const value = JSON.parse(await readFile(sshApprovalsPath(this.profileDir), 'utf8')) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, ApprovalRow>)
        : {}
    } catch {
      return {}
    }
  }
  async set(node: NodeId, row: ApprovalRow): Promise<void> {
    const all = await this.read()
    await writeJsonAtomic(sshApprovalsPath(this.profileDir), { ...all, [node]: row })
  }
  async remove(node: NodeId): Promise<void> {
    const all = await this.read()
    if (!Object.hasOwn(all, node)) return
    delete all[node]
    await writeJsonAtomic(sshApprovalsPath(this.profileDir), all)
  }
}
