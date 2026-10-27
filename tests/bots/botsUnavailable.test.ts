/**
 * PR 6: a `bots.db` that cannot be opened or read fails closed for bots only. The profile still
 * opens and its ordinary threads still run turns; bot methods report bots unavailable, and a known
 * bot thread stays read-only when a read of `bots.db` fails.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPersonalBots } from '../../src/mms/bots/activation/open'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/** A profile home whose `bots/` is a file, so `bots.db` cannot be opened. */
function brokenHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bots-unavailable-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(join(home, 'bots'), 'not a folder')
  return home
}

describe('an unopenable bots.db', () => {
  it('leaves bots unavailable without throwing', () => {
    const home = brokenHome()
    expect(openPersonalBots({ profileHome: home, threads: { ensureExecutionThread: () => ({ id: 't' }) }, runs: () => null, harness: {} as never, notifyEffects: () => {} })).toBeNull()
  })

  it('the profile opens, an ordinary send runs, and bot methods refuse', async () => {
    const home = brokenHome()
    const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
    cleanup.push(() => auth.stop())
    const domains = new DomainHandlerRegistry()
    const services = new MmsProfileServices(
      MousseConfigStore.load(home),
      { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
      null,
      home,
      { providerAuth: auth, domains, installationHome: home, profileId: randomUUID(), allowLegacyProjectData: false }
    )
    cleanup.push(() => services.stop())
    expect(services.personalBots).toBeNull()

    // An ordinary thread's send reaches its turn.
    const thread = services.threads.createThread('Plain thread')
    const runTurn = vi.fn(async () => ({ message: 'ok', actions: [] }))
    ;(services.orchestrator as unknown as { runTurnOnSession: unknown }).runTurnOnSession = runTurn
    await services.orchestrator.send({ content: 'hello', mode: 'agent' }, false, { threadId: thread.id })
    expect(runTurn).toHaveBeenCalledTimes(1)

    registerPersonalBotMethods(domains, () => services.personalBots)
    const context = { connection: { id: 'c', binding: { profileId: 'p', epoch: 1 }, capabilities: new Set<string>() } } as unknown as HandlerContext
    await expect(domains.dispatch(context, 'bots.definitions.list', {})).rejects.toMatchObject({ code: 'bots_unavailable' })
  }, 60_000)
})
