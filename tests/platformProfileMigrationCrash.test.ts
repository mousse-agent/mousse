import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { ControlStore } from '../src/mms/control/storage/controlStore'
import {
  createControlStoreCredentialAdapter,
  createInstallationPaths,
  createRetainingGitWorktreeAdapter,
  ProfileManager,
  ProfileMigrationService
} from '../src/mms/profiles'
import type { MigrationStepId } from '../src/mms/profiles/migration/types'
import { FIXTURE_CONTROL_CREDENTIALS, FIXTURE_LEGACY_MOUSSE_CONF } from '../src/shared/profiles'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function legacyHome(root: string): string {
  const home = join(root, 'home')
  mkdirSync(join(home, 'thread-data', 'standalone', 'thread-a'), { recursive: true })
  mkdirSync(join(home, 'thread-data', 'standalone', 'thread-b'), { recursive: true })
  mkdirSync(join(home, 'scheduled'), { recursive: true })
  mkdirSync(join(home, 'browser', 'Default'), { recursive: true })
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'installation-only-fixture-secret' } }))
  writeFileSync(join(home, 'mousse.conf'), JSON.stringify({
    ...FIXTURE_LEGACY_MOUSSE_CONF,
    scheduled: { enabled: false, jobs: [{
      id: 'schedule-disabled', name: 'Disabled fixture', prompt: 'local status', enabled: false,
      schedule: { kind: 'interval', minutes: 60 },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }] }
  }))
  writeFileSync(join(home, 'projects.json'), JSON.stringify([]))
  writeFileSync(join(home, 'threads-index.json'), JSON.stringify({
    'thread-a': { id: 'thread-a', title: 'Legacy A' },
    'thread-b': { id: 'thread-b', title: 'Legacy B' }
  }))
  writeFileSync(join(home, 'active-thread.json'), JSON.stringify({ threadId: 'thread-b' }))
  writeFileSync(join(home, 'thread-data', 'standalone', 'thread-a', 'transcript.json'), JSON.stringify({ id: 'thread-a', messages: [{ id: 'a-1' }] }))
  writeFileSync(join(home, 'thread-data', 'standalone', 'thread-b', 'transcript.json'), JSON.stringify({ id: 'thread-b', messages: [{ id: 'b-1' }] }))
  writeFileSync(join(home, 'scheduled', 'jobs-runtime.json'), JSON.stringify({
    'schedule-disabled': { state: 'paused', nextRunAt: null, runHistory: [] }
  }))
  writeFileSync(join(home, 'browser', 'Default', 'cookie.txt'), 'legacy-default-cookie')
  new ControlStore(home).saveCredentials({ ...FIXTURE_CONTROL_CREDENTIALS })
  return home
}

async function crash(root: string, home: string, crashAfter: MigrationStepId): Promise<void> {
  const bundleDir = join(root, 'bundle')
  mkdirSync(bundleDir, { recursive: true })
  const child = join(bundleDir, 'migration-child.mjs')
  await build({
    entryPoints: [resolve('tests/fixtures/agent-platform/migration-crash/child.ts')],
    outfile: child, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent'
  })
  const config = join(root, `crash-${crashAfter}.json`)
  writeFileSync(config, JSON.stringify({ home, crashAfter }))
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((done, reject) => {
    const processEnv = { ...process.env, MOUSSE_MIGRATION_CRASH_CONFIG: config }
    const childProcess = spawn(process.execPath, [child], { cwd: process.cwd(), env: processEnv, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => { childProcess.kill('SIGKILL'); reject(new Error(`Migration crash fixture timed out: ${stderr}`)) }, 15_000)
    childProcess.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4_000) })
    childProcess.once('error', (error) => { clearTimeout(timer); reject(error) })
    childProcess.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal, stderr }) })
  })
  expect(result.code, result.stderr).not.toBe(0)
}

describe('profile migration recovery after abrupt process loss', () => {
  for (const crashAfter of ['promote-staging', 'migrate-credentials'] as const) {
    it(`recovers one authoritative layout after SIGKILL following ${crashAfter}`, async () => {
      const root = mkdtempSync(join(tmpdir(), `mousse-migration-crash-${crashAfter}-`))
      roots.push(root)
      const home = legacyHome(root)
      await crash(root, home, crashAfter)

      const installation = createInstallationPaths(home)
      const interrupted = JSON.parse(readFileSync(installation.migrationJournal, 'utf8')) as {
        currentStep: string; completedSteps: string[]; defaultProfileId: string
      }
      expect(interrupted.currentStep).toBe(crashAfter)
      expect(interrupted.completedSteps).not.toContain(crashAfter)

      const manager = ProfileManager.open(installation)
      const recovered = new ProfileMigrationService(installation, manager).run({ adapters: {
        credentials: createControlStoreCredentialAdapter(),
        gitWorktrees: createRetainingGitWorktreeAdapter()
      } })
      expect(recovered.alreadyCommitted).toBe(true)
      expect(recovered.defaultProfileId).toBe(interrupted.defaultProfileId)
      expect(manager.list()).toHaveLength(1)
      const profileRoot = installation.profileRoot(recovered.defaultProfileId!)
      expect(readdirSync(installation.profilesDir)).toEqual([recovered.defaultProfileId])
      expect(existsSync(join(installation.migrationStagingDir, 'profiles', recovered.defaultProfileId!))).toBe(false)
      expect(JSON.parse(readFileSync(join(profileRoot, 'threads-index.json'), 'utf8'))).toEqual({
        'thread-a': { id: 'thread-a', title: 'Legacy A' },
        'thread-b': { id: 'thread-b', title: 'Legacy B' }
      })
      expect(JSON.parse(readFileSync(join(profileRoot, 'active-thread.json'), 'utf8'))).toEqual({ threadId: 'thread-b' })
      expect(JSON.parse(readFileSync(join(profileRoot, 'scheduled', 'jobs-runtime.json'), 'utf8'))).toEqual({
        'schedule-disabled': { state: 'paused', nextRunAt: null, runHistory: [] }
      })
      expect(readFileSync(join(profileRoot, 'browser', 'Default', 'cookie.txt'), 'utf8')).toBe('legacy-default-cookie')
      expect(new ControlStore(profileRoot).getCredentials()).toEqual(FIXTURE_CONTROL_CREDENTIALS)

      expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('installation-only-fixture-secret')
      expect(() => readFileSync(join(profileRoot, 'auth.json'), 'utf8')).toThrow()
      const b = manager.create({ displayName: 'Profile B', slug: 'profile-b' })
      const bRoot = installation.profileRoot(b.id)
      expect(() => readFileSync(join(bRoot, 'threads-index.json'), 'utf8')).toThrow()
      expect(() => readFileSync(join(bRoot, 'auth.json'), 'utf8')).toThrow()
      expect(new ControlStore(bRoot).getCredentials()).toBeNull()

      const again = new ProfileMigrationService(installation, manager).run({ adapters: {
        credentials: createControlStoreCredentialAdapter(), gitWorktrees: createRetainingGitWorktreeAdapter()
      } })
      expect(again.defaultProfileId).toBe(recovered.defaultProfileId)
      expect(manager.list()).toHaveLength(2)
    }, 30_000)
  }
})
