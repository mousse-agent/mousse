/**
 * The title bar's New thread picker starts on for a new profile and off for one already in use, decided when the
 * profile first opens without a value, and never changed on its own after that.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { MmsProfileServices } from '../src/mms/MmsProfileServices'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { SettingsStore } from '../src/mms/settings/SettingsStore'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-new-thread-picker-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  return home
}

/** Opens the profile as the service does at start, then reads the setting back from disk. */
async function openProfile(home: string): Promise<boolean | undefined> {
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  const services = new MmsProfileServices(
    MousseConfigStore.load(home),
    { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
    null,
    home,
    { providerAuth: auth, domains: new DomainHandlerRegistry(), installationHome: home, profileId: randomUUID(), allowLegacyProjectData: false }
  )
  await services.stop()
  auth.stop()
  return new SettingsStore(MousseConfigStore.load(home)).get().runs.newThreadPicker
}

function addProject(home: string): void {
  const folder = join(home, 'work', 'web-app')
  mkdirSync(folder, { recursive: true })
  new ProjectManager(home).openProject(folder)
}

describe('the New thread picker default', () => {
  it('is on for a new profile, and stays on after projects are added', async () => {
    const home = freshHome()
    expect(await openProfile(home)).toBe(true)
    addProject(home)
    expect(await openProfile(home)).toBe(true)
  }, 60_000)

  it('is off for a profile that already had projects, and stays off', async () => {
    const home = freshHome()
    addProject(home)
    expect(await openProfile(home)).toBe(false)
    expect(await openProfile(home)).toBe(false)
  }, 60_000)

  it('keeps what the person chose', async () => {
    const home = freshHome()
    addProject(home)
    MousseConfigStore.load(home).setRunsKey('newThreadPicker', true)
    expect(await openProfile(home)).toBe(true)
  }, 60_000)
})
