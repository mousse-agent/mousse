import { join } from 'path'
import { getMousseHomeDir } from './paths'

/** Home-scoped locations for durable thread payloads. */
export class ThreadStorageLayout {
  constructor(private readonly homeDir = getMousseHomeDir(), readonly allowLegacyProjectData = true) {}

  get standaloneRoot(): string {
    return join(this.homeDir, 'thread-data', 'standalone')
  }

  get repositoriesRoot(): string {
    return join(this.homeDir, 'thread-data', 'repositories')
  }

  standaloneThreadDir(threadId: string): string {
    return join(this.standaloneRoot, storageIdentity(threadId))
  }

  repositoryRoot(repositoryId: string): string {
    return join(this.repositoriesRoot, storageIdentity(repositoryId))
  }

  repositoryThreadDir(repositoryId: string, threadId: string): string {
    return join(this.repositoryRoot(repositoryId), storageIdentity(threadId))
  }

  legacyStandaloneThreadDir(threadId: string): string {
    return join(this.homeDir, '.data', storageIdentity(threadId))
  }

  legacyRepositoryThreadDir(projectPath: string, threadId: string): string {
    return join(projectPath, '.mousse', '.data', storageIdentity(threadId))
  }

  legacyRepositoryRoot(projectPath: string): string {
    return join(projectPath, '.mousse', '.data')
  }

  migrationTrashDir(threadId: string): string {
    return join(this.homeDir, 'thread-data', '.migration-trash', `${storageIdentity(threadId)}-${Date.now()}`)
  }
}

function storageIdentity(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) throw new Error('Invalid storage identity')
  return value
}
