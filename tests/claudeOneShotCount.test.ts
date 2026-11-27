/**
 * `claude:cli` claims one request on the wire (`attempts: one`). Counted here at a stub: the Claude Code the Agent SDK
 * ships, started through the service's single-request transport as a title request starts it, against a loopback
 * Anthropic API that answers every request 429 or 503. A dummy API key; no sign-in. Without
 * `ONE_SHOT_SINGLE_REQUEST_ENV` it sends 11 requests over about three minutes (seen with this SDK's 2.1 build).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionProviderService } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import type { ModelCatalog } from '../src/shared/modelCatalog'
import { claudeCodeDriver } from '../src/mms/harness/drivers/claudeCode'
import type { OneShotRouteInput } from '../src/mms/harness/driver'
import { routeLabel } from '../src/mms/harness/oneShot/admission'

/** The Claude Code build the SDK ships for this computer, when it is installed. */
function bundledClaude(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const binary = join(dirname(manifest), process.platform === 'win32' ? 'claude.exe' : 'claude')
    return existsSync(binary) ? binary : undefined
  } catch {
    return undefined
  }
}

const binary = bundledClaude()
const homes: string[] = []
const servers: Server[] = []
const services: ClaudeSubscriptionProviderService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const server of servers.splice(0)) server.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  vi.unstubAllEnvs()
})

/** An Anthropic API stand-in that answers every request with `status`, counting them. */
async function stub(status: number): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = []
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      hits.push(`${request.method} ${request.url}`)
      response.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '0' } : {}) })
      response.end(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'overloaded_error', message: 'stub' } }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, hits }
}

describe.runIf(binary)('claude:cli sends one request', () => {
  it.each([429, 503])('a model answered %i is asked once, and the request fails', async (status) => {
    const api = await stub(status)
    const home = mkdtempSync(join(tmpdir(), 'claude-one-shot-count-'))
    homes.push(home)
    const config = join(home, 'claude-config')
    mkdirSync(config)
    vi.stubEnv('CLAUDE_CONFIG_DIR', config)
    const directory = join(home, 'providers', 'claude-subscription')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'claude-haiku-4-5', label: 'Haiku' }] }))
    const env = { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-stub', CLAUDE_CONFIG_DIR: config, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'api_key' }),
      live: false,
      launchConfig: () => ({ binaryPath: binary!, env }),
      modelCatalog: (): ModelCatalog => ({ format: 1, revision: 0, models: [] })
    })
    services.push(service)
    await service.status()
    // Longer than its first retries would take: without the switches it would have asked again by then.
    const failed = await service.oneShotTransport({ model: 'claude-haiku-4-5', task: 'pull_request' })
      .send({ model: 'claude-haiku-4-5', system: 'You write pull request drafts.', prompt: 'Draft it.' }, { activity: () => {}, text: () => {}, tool: () => {}, launching: () => {}, sending: () => {} }, AbortSignal.timeout(20_000))
      .then(() => undefined, (error: unknown) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(String((failed as Error).message)).not.toMatch(/aborted|timed? ?out/i)
    expect(api.hits.filter((hit) => hit.startsWith('POST /v1/messages'))).toHaveLength(1)
    // Its place is gone once its process has.
    await service.stop()
    expect(readdirSync(join(home, 'one-shot-ledger'))).toEqual([])
  }, 60_000)
})

describe('the claude:cli label', () => {
  const input = { config: {}, installedVersion: undefined, instanceId: 'claude', model: 'haiku' } as OneShotRouteInput
  const routeOf = (managed: boolean) => {
    const decision = claudeCodeDriver({ managedSettingsFile: () => managed }).oneShotRoute!(input)
    if (!('route' in decision)) throw new Error(decision.refused)
    return decision.route
  }

  it('is held: no tool offered, one request on the wire, and no user config loads', () => {
    const route = routeOf(false)
    expect(route).toMatchObject({ id: 'claude:cli', facts: { tools: 'none_offered', attempts: 'one', isolation: 'verified' } })
    expect(routeLabel(route)).toBe('held')
  })

  it('is best-effort where a managed settings file can enforce hooks Mousse cannot turn off', () => {
    const route = routeOf(true)
    expect(route.facts).toMatchObject({ isolation: 'env_only' })
    expect(routeLabel(route)).toBe('best_effort')
  })
})
