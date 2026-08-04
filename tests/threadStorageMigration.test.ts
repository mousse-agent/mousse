import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { ThreadStorageLayout } from '../src/mms/data/ThreadStorageLayout'
import { ThreadStorageMigration } from '../src/mms/data/ThreadStorageMigration'

function withHome(run: (root: string) => void): void {
  const previous = process.env.MOUSSE_HOME
  const root = mkdtempSync(join(tmpdir(), 'mousse-thread-storage-'))
  process.env.MOUSSE_HOME = join(root, 'home')
  try { run(root) } finally {
    if (previous === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
}

describe('ThreadStorageMigration', () => {
  it('atomically migrates legacy repository data to home-scoped repository storage', () => {
    withHome((root) => {
      const projectPath = join(root, 'project')
      const legacy = join(projectPath, '.mousse', '.data', 'thread-1')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, 'meta.json'), '{"id":"thread-1"}')

      const layout = new ThreadStorageLayout()
      const destination = new ThreadStorageMigration(layout).migrateRepository(projectPath, 'repo-1', 'thread-1')

      expect(destination).toBe(layout.repositoryThreadDir('repo-1', 'thread-1'))
      expect(JSON.parse(readFileSync(join(destination, 'meta.json'), 'utf8'))).toEqual({ id: 'thread-1' })
      expect(existsSync(legacy)).toBe(false)
      expect(existsSync(join(layout.repositoriesRoot, 'repo-1'))).toBe(true)
    })
  })

  it('leaves the verified destination in place on repeated migrations', () => {
    withHome((root) => {
      const projectPath = join(root, 'project')
      const legacy = join(projectPath, '.mousse', '.data', 'thread-1')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, 'payload'), 'original')
      const migration = new ThreadStorageMigration()
      const first = migration.migrateRepository(projectPath, 'repo-1', 'thread-1')
      const second = migration.migrateRepository(projectPath, 'repo-1', 'thread-1')
      expect(second).toBe(first)
      expect(readFileSync(join(second, 'payload'), 'utf8')).toBe('original')
    })
  })
})
