import { join } from 'path'
import { getMousseHomeDir } from './paths'

/** Home-scoped locations for durable thread payloads. */
export class ThreadStorageLayout {
  constructor(private readonly homeDir = getMousseHomeDir()) {}

  get standaloneRoot(): string {
    return join(this.homeDir, 'thread-data', 'standalone')
  }

  get repositoriesRoot(): string {
    return join(this.homeDir, 'thread-data', 'repositories')
  }

  standaloneThreadDir(threadId: string): string {
    return join(this.standaloneRoot, threadId)
  }

  repositoryRoot(repositoryId: string): string {
    return join(this.repositoriesRoot, repositoryId)
  }

  repositoryThreadDir(repositoryId: string, threadId: string): string {
    return join(this.repositoryRoot(repositoryId), threadId)
  }

  legacyStandaloneThreadDir(threadId: string): string {
    return join(this.homeDir, '.data', threadId)
  }

  legacyRepositoryThreadDir(projectPath: string, threadId: string): string {
    return join(projectPath, '.mousse', '.data', threadId)
  }

  legacyRepositoryRoot(projectPath: string): string {
    return join(projectPath, '.mousse', '.data')
  }

  migrationTrashDir(threadId: string): string {
    return join(this.homeDir, 'thread-data', '.migration-trash', `${threadId}-${Date.now()}`)
  }
}
