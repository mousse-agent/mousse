import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'

const AUTH_FILE_WRITE_OPTIONS = { encoding: 'utf-8' as const, mode: 0o600 }

export class FileCredentialStore implements CredentialStore {
  private data = new Map<string, Credential>()
  private chains = new Map<string, Promise<unknown>>()

  constructor(private readonly path: string) {
    this.load()
  }

  listProviderIds(): string[] {
    return [...this.data.keys()]
  }

  has(providerId: string): boolean {
    return this.data.has(providerId)
  }

  get(providerId: string): Credential | undefined {
    return this.data.get(providerId)
  }

  private load(): void {
    this.ensureParentDir()
    if (!existsSync(this.path)) {
      this.persist()
      return
    }

    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, Credential>
      this.data = new Map(Object.entries(parsed))
    } catch {
      this.data = new Map()
    }
  }

  private ensureParentDir(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }

  private persist(): void {
    this.ensureParentDir()
    const serialized = JSON.stringify(Object.fromEntries(this.data), null, 2)
    writeFileSync(this.path, serialized, AUTH_FILE_WRITE_OPTIONS)
    chmodSync(this.path, 0o600)
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve()
    const next = (async () => {
      await previous.catch(() => {})
      return task()
    })()
    this.chains.set(providerId, next.catch(() => {}))
    return next
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.data.get(providerId)
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const current = this.data.get(providerId)
      const next = await fn(current)
      if (next !== undefined) {
        this.data.set(providerId, next)
        this.persist()
        return next
      }
      return current
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      if (!this.data.delete(providerId)) return
      this.persist()
    })
  }
}
