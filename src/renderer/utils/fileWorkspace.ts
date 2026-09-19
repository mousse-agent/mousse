export type ExternalReconciliation =
  | { kind: 'unchanged' }
  | { kind: 'replace'; content: string }
  | { kind: 'conflict'; diskContent: string }

/** Decide how a polling read may be applied without ever discarding editor bytes. */
export function reconcileExternalContent(savedContent: string, localContent: string, diskContent: string): ExternalReconciliation {
  if (diskContent === savedContent) return { kind: 'unchanged' }
  if (localContent === savedContent) return { kind: 'replace', content: diskContent }
  return { kind: 'conflict', diskContent }
}

export interface AutosaveAttempt {
  content: string
  baseline: string
}

export function normalizeWorkspacePath(filePath: string, workspaceRoot = ''): string {
  const slash = (value: string) => value.replace(/\\/g, '/')
  const normalizeSegments = (value: string): string => {
    const prefix = /^[A-Za-z]:\//.exec(value)?.[0] ?? (value.startsWith('/') ? '/' : '')
    const rest = prefix ? value.slice(prefix.length) : value
    const segments: string[] = []
    for (const segment of rest.split('/')) {
      if (!segment || segment === '.') continue
      if (segment === '..' && segments.length && segments.at(-1) !== '..') segments.pop()
      else if (segment !== '..' || !prefix) segments.push(segment)
    }
    return `${prefix}${segments.join('/')}` || (prefix ? prefix : '.')
  }

  const path = normalizeSegments(slash(filePath.trim()))
  const root = workspaceRoot ? normalizeSegments(slash(workspaceRoot.trim())).replace(/\/$/, '') : ''
  if (!root) return path.replace(/^\.\//, '')
  const caseInsensitive = /^[A-Za-z]:\//.test(root)
  const comparablePath = caseInsensitive ? path.toLowerCase() : path
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root
  if (comparablePath === comparableRoot) return '.'
  if (comparablePath.startsWith(`${comparableRoot}/`)) return path.slice(root.length + 1)
  return path.replace(/^\.\//, '')
}

interface SerializedAutosaveOptions {
  read: () => Promise<string>
  write: (content: string) => Promise<void>
  onSaved: (content: string) => void
  onConflict: (diskContent: string) => void
  onError: (error: unknown) => void
  delay?: number
}

/**
 * A trailing debounce with one writer. Every write is preceded by a disk read,
 * preventing a known external update from being silently overwritten.
 */
export class SerializedAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: AutosaveAttempt | undefined
  private running: Promise<void> | undefined
  private disposed = false

  constructor(private readonly options: SerializedAutosaveOptions) {}

  schedule(attempt: AutosaveAttempt): void {
    if (this.disposed) return
    this.pending = attempt
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, this.options.delay ?? 650)
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.drain()
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  isBusy(): boolean {
    return this.running !== undefined
  }

  private async drain(): Promise<void> {
    if (this.running) {
      await this.running
      return
    }
    if (!this.pending || this.disposed) return
    this.running = this.runLoop()
    try {
      await this.running
    } finally {
      this.running = undefined
    }
  }

  private async runLoop(): Promise<void> {
    while (this.pending && !this.disposed) {
      const attempt = this.pending
      this.pending = undefined
      const outcome = await this.perform(attempt)
      if (outcome === 'saved') {
        // The UI cannot know the first write succeeded while it is in flight, so edits
        // made during it still carry its old baseline. Only that exact lineage is ours
        // to rebase; any other baseline must still be treated as an external conflict.
        const nextAttempt = this.pending as AutosaveAttempt | undefined
        if (nextAttempt?.baseline === attempt.baseline) {
          this.pending = { ...nextAttempt, baseline: attempt.content }
        }
        continue
      }
      if (outcome === 'error') this.pending ??= attempt
      else this.pending = undefined
      return
    }
  }

  private async perform(attempt: AutosaveAttempt): Promise<'saved' | 'conflict' | 'error'> {
    try {
      const diskContent = await this.options.read()
      if (this.disposed) return 'error'
      if (diskContent !== attempt.baseline) {
        this.options.onConflict(diskContent)
        return 'conflict'
      }
      await this.options.write(attempt.content)
      if (this.disposed) return 'error'
      this.options.onSaved(attempt.content)
      return 'saved'
    } catch (error) {
      if (!this.disposed) this.options.onError(error)
      return 'error'
    }
  }
}
