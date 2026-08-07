import { createHash, randomUUID } from 'crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, readFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { ThreadStorageLayout } from './ThreadStorageLayout'

/**
 * Moves a legacy thread directory into the home-scoped layout on first access.
 * A failed or contended migration deliberately returns the legacy directory, so
 * callers can continue to read/write without risking data loss.
 */
export class ThreadStorageMigration {
  constructor(private readonly layout = new ThreadStorageLayout()) {}

  migrateStandalone(threadId: string): string {
    return this.migrate(this.layout.legacyStandaloneThreadDir(threadId), this.layout.standaloneThreadDir(threadId), threadId)
  }

  migrateRepository(projectPath: string, repositoryId: string, threadId: string): string {
    return this.migrate(
      this.layout.legacyRepositoryThreadDir(projectPath, threadId),
      this.layout.repositoryThreadDir(repositoryId, threadId),
      threadId
    )
  }

  private migrate(legacyDir: string, targetDir: string, threadId: string): string {
    if (existsSync(targetDir) || !existsSync(legacyDir)) return targetDir

    const lockDir = `${targetDir}.migration-lock`
    try {
      mkdirSync(dirname(lockDir), { recursive: true })
      mkdirSync(lockDir)
    } catch {
      // Another process may be migrating. Never guess that its partial copy is valid.
      return existsSync(targetDir) ? targetDir : legacyDir
    }

    const temporaryDir = `${targetDir}.${process.pid}.${randomUUID()}.tmp`
    try {
      // Recheck under the lock: migration is idempotent across restarts/processes.
      if (existsSync(targetDir)) return targetDir
      cpSync(legacyDir, temporaryDir, { recursive: true, errorOnExist: true })
      if (this.directoryHash(legacyDir) !== this.directoryHash(temporaryDir)) {
        throw new Error('Thread migration verification failed')
      }
      mkdirSync(dirname(targetDir), { recursive: true })
      renameSync(temporaryDir, targetDir)

      // Keep the source recoverable rather than deleting it. It is intentionally
      // retained until a future cleanup policy can safely expire migration trash.
      const trashDir = this.layout.migrationTrashDir(threadId)
      mkdirSync(dirname(trashDir), { recursive: true })
      renameSync(legacyDir, trashDir)
      return targetDir
    } catch {
      rmSync(temporaryDir, { recursive: true, force: true })
      return existsSync(targetDir) ? targetDir : legacyDir
    } finally {
      rmSync(lockDir, { recursive: true, force: true })
    }
  }

  private directoryHash(directory: string): string {
    const hash = createHash('sha256')
    const files: string[] = []
    const visit = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (entry.isFile()) files.push(path)
      }
    }
    visit(directory)
    for (const path of files.sort()) {
      hash.update(relative(directory, path).replace(/\\/g, '/'))
      hash.update('\0')
      hash.update(readFileSync(path))
      hash.update('\0')
    }
    return hash.digest('hex')
  }
}
