/**
 * The background job service as a profile opens it (`MmsProfileServices`), with real processes: a thread's command runs
 * with the shell PATH its agent's own commands get, and each profile has its own service, so one profile closing never
 * ends another's commands and neither lists the other's.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { setSharedShellPath } from '../../src/mms/harness/shellPath'
import { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  setSharedShellPath(undefined)
})

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return dir
}

function profile(): MmsProfileServices {
  const home = temp('mousse-jobs-profile-')
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const services = new MmsProfileServices(
    MousseConfigStore.load(home),
    { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
    null,
    home,
    { providerAuth: auth, domains: new DomainHandlerRegistry(), installationHome: home, profileId: randomUUID(), allowLegacyProjectData: false }
  )
  cleanup.push(() => services.stop())
  return services
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('background jobs as a profile opens them', () => {
  it('a thread\'s command gets the shell PATH; each profile has its own jobs, and one closing leaves the other\'s running', async () => {
    const dir = temp('mousse-jobs-script-')
    // A folder only the login shell's PATH has, as the daemon learns it at start.
    const shellOnly = join(dir, 'shell-only-bin')
    setSharedShellPath({ entries: [shellOnly], source: 'login_shell' })
    const script = join(dir, 'job.js')
    writeFileSync(script, `
const go = process.argv[2]
console.log('path=' + process.env.PATH)
setInterval(() => { if (require('fs').existsSync(go)) process.exit(0) }, 25)
`)
    const go = join(dir, 'go')
    const a = profile()
    const b = profile()
    // The profile asks for the shell PATH as it opens; its answer lands a tick later.
    await new Promise((resolve) => setImmediate(resolve))

    const thread = a.threads.createThread('Build')
    const job = a.monitors.startBackground({ threadId: thread.id, description: 'build', command: `"${process.execPath}" "${script}" "${go}"`, cwd: dir })
    expect(a.backgroundJobs.list().map((entry) => entry.id)).toEqual([job.id])
    expect(b.backgroundJobs.list()).toEqual([])
    await until(() => (a.backgroundJobs.output({ kind: 'thread', threadId: thread.id }, job.id)?.output ?? '').includes('path='))

    // The other profile closes; this one's command runs on.
    await b.stop()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(a.backgroundJobs.list().map((entry) => entry.id)).toEqual([job.id])

    writeFileSync(go, '')
    await until(() => !a.backgroundJobs.has(job.id))
    const kept = a.backgroundJobs.output({ kind: 'thread', threadId: thread.id }, job.id)!
    expect(kept.end).toMatchObject({ reason: 'exit', code: 0 })
    const path = /path=(.*)/.exec(kept.output)![1]!.trim()
    expect(path.split(delimiter)).toContain(shellOnly)
  }, 120_000)
})
