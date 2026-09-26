/** Explicit manual qualification; never imported by the ordinary test suite. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import type { Credential } from '@earendil-works/pi-ai'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { MmsProtocolServer, LocalMmsClient } from '../../src/mms/protocol'
import { AgentEpisodeStore } from '../../src/mms/agents/AgentEpisodeStore'
import type { AgentEpisode, AgentEpisodeState } from '../../src/shared/agentEpisodes'
import { git, gitFoundationFixture } from './gitFoundation'

const evidencePath = process.env.MOUSSE_LIVE_EVIDENCE
if (!evidencePath) throw new Error('Explicit MOUSSE_LIVE_EVIDENCE is required')
const providerId = 'opencode-go', modelId = 'deepseek-v4.1-flash'
const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
const authBytes = readFileSync(authPath), saved = JSON.parse(authBytes.toString('utf8'))[providerId]
if (saved?.type !== 'api' || typeof saved.key !== 'string' || !saved.key) throw new Error('Authorized OpenCode Go API credential unavailable')
const secret: string = saved.key
for (const name of ['log', 'warn', 'error'] as const) {
  const output = console[name].bind(console)
  console[name] = (...values: unknown[]) => output(...values.map((value) => (typeof value === 'string' ? value : inspect(value)).split(secret).join('[redacted]')))
}
const f = gitFoundationFixture()
let main: MousseMainService | undefined, server: MmsProtocolServer | undefined, rpc: LocalMmsClient | undefined
let phase = 'startup', threadId: string | undefined
const evidence: Record<string, unknown> = { providerId, modelId, credentialSource: 'existing OpenCode auth; memory only', boundedEpisodes: 2 }
const stop = async () => { await rpc?.close(); rpc = undefined; await server?.stop(); server = undefined; await main?.stop(); main = undefined }
const start = async () => {
  main = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
  // Substitute only credential persistence; model, transport and tools stay real.
  let credential: Credential | undefined = { type: 'api_key', key: secret }
  const credentials = main.providerAuth.credentials
  credentials.read = async (id) => id === providerId ? credential : undefined
  credentials.get = (id) => id === providerId ? credential : undefined
  credentials.has = (id) => id === providerId && Boolean(credential)
  credentials.listProviderIds = () => [providerId]
  credentials.list = async () => [{ providerId, type: 'api_key' as const }]
  credentials.modify = async (id, update) => id === providerId ? (credential = await update(credential)) : undefined
  await main.providerAuth.refreshDynamicModels()
  if (!main.providerAuth.models.getModels(providerId).some((model) => model.id === modelId)) throw new Error('Authorized model unavailable')
  const settings = main.settings.get()
  main.settings.set({ provider: { llmProvider: providerId, model: modelId }, integrations: { ...settings.integrations,
    tools: { enabled: true, enabledTools: ['read', 'write'] }, skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false } } })
  await main.start()
  const ownerToken = main.getOwnerLease()!.owner.token
  server = new MmsProtocolServer({ mms: main, ownerToken })
  rpc = new LocalMmsClient({ homeDir: f.home, endpoint: await server.start(), ownerToken, clientType: 'gui' })
  await rpc.connect()
}
const settled = async (operationId: string): Promise<{ episode: AgentEpisode; state: AgentEpisodeState }> => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const state = await rpc!.request<AgentEpisodeState>('agents.listNamed', { threadId })
    const episode = state.episodes.find((entry) => entry.id === operationId)
    if (episode && ['failed', 'interrupted'].includes(episode.state)) throw new Error(`Live episode ${episode.state}: ${episode.result?.reason ?? 'no result'}`)
    if (episode?.state === 'completed' && !existsSync(episode.binding.worktreePath)) return { episode, state }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Live episode did not complete and retire within its bounded interval')
}
try {
  await start()
  const project = main!.projects.openProject(f.repo)
  threadId = main!.threads.createThread('Bounded named lifecycle live verification', project.id).id
  const threadDirectory = main!.threads.getThreadDir(threadId), marker = 'MEMORY_KITE_7319'
  phase = 'named-write'
  await rpc!.request('agents.createNamed', { threadId, name: 'LiveKeeper', operationId: 'live-named-create', workspace: 'isolated', access: 'write', provider: providerId, model: modelId,
    task: `Bounded local test. Remember the private phrase ${marker} in your conversation only; never write it to a file. Read value.txt, use write to replace it with exactly named-live-ok followed by one newline, then read to verify. Touch no other files. Do not run commands, browse, delegate, or use other services. Reply NAMED_EDIT_OK when done.` })
  const first = await settled('live-named-create'), identity = first.state.identities[0]
  if (git(f.repo, 'show', `${first.episode.result!.resultSha}:value.txt`) !== 'named-live-ok') throw new Error('Live named result lacks exact requested bytes')
  if (identity.state !== 'dormant') throw new Error('Completed identity is not dormant')
  evidence.namedEdit = true; evidence.dormantCheckoutAbsent = true
  phase = 'restart'
  await stop(); await start()
  const afterRestart = await rpc!.request<AgentEpisodeState>('agents.listNamed', { threadId })
  if (afterRestart.episodes.length !== 1 || afterRestart.identities[0].id !== identity.id) throw new Error('Restart changed identity or replayed an episode')
  phase = 'named-recall'
  await rpc!.request('agents.recallNamed', { threadId, agent: identity.id, operationId: 'live-named-recall', expectedAgentGeneration: 1, workspace: 'isolated', access: 'read-only', resumeResult: true, provider: providerId, model: modelId,
    task: 'Bounded continuation. Use read to verify value.txt still contains named-live-ok. Reply with the private phrase I asked you to remember, followed by NAMED_RECALL_OK. Do not write, run commands, browse, delegate or use other services.' })
  const recalled = await settled('live-named-recall')
  const snapshot = new AgentEpisodeStore(threadDirectory).context(identity.id)
  const messages = snapshot?.nativeContext?.messages ?? []
  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!JSON.stringify(last).includes(marker) || !JSON.stringify(last).includes('NAMED_RECALL_OK')) throw new Error('Recalled model did not reproduce retained private context')
  if (recalled.state.identities[0].id !== identity.id || recalled.state.identities[0].contextGeneration !== 2) throw new Error('Recall replaced identity or failed to advance context')
  if (recalled.episode.binding.baseSha !== first.episode.result!.resultSha) throw new Error('Recall did not select retained isolated result')
  if (f.read(f.repo) !== 'base\n' || git(f.repo, 'rev-parse', 'HEAD') !== f.baseSha || git(f.repo, 'status', '--porcelain')) throw new Error('Primary checkout changed')
  if (!readFileSync(authPath).equals(authBytes)) throw new Error('Saved credentials changed')
  Object.assign(evidence, { ok: true, sameIdentity: true, nativeContextRecalled: true, recalledCheckoutAbsent: true, primaryPreserved: true, savedCredentialsUnchanged: true })
} catch (error) {
  Object.assign(evidence, { ok: false, phase, error: error instanceof Error ? error.message.split(secret).join('[redacted]') : 'Unknown live failure' })
  process.exitCode = 1
} finally {
  if (threadId) await rpc?.request('orchestrator.stop', { threadId }).catch(() => undefined)
  await stop(); writeFileSync(evidencePath, JSON.stringify(evidence, null, 2)); f.dispose()
}
