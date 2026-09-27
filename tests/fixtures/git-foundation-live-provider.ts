/** Explicit manual qualification only: never imported by the normal suite.
 * Reads the authorized OpenCode credential into memory, never saves its value. */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import type { Credential } from '@earendil-works/pi-ai'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { MmsProtocolServer } from '../../src/mms/protocol/server'
import { LocalMmsClient } from '../../src/mms/protocol/client'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { git, gitFoundationFixture } from './gitFoundation'

const evidencePath = process.env.MOUSSE_LIVE_EVIDENCE
if (!evidencePath) throw new Error('Explicit MOUSSE_LIVE_EVIDENCE is required')
const providerId = 'opencode-go'
const modelId = 'deepseek-v4.1-flash'
const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
const authBytes = readFileSync(authPath)
const saved = JSON.parse(authBytes.toString('utf8'))[providerId]
if (saved?.type !== 'api' || typeof saved.key !== 'string' || !saved.key) throw new Error('Authorized OpenCode Go API credential unavailable')
const secret: string = saved.key
for (const name of ['log', 'warn', 'error'] as const) {
  const output = console[name].bind(console)
  console[name] = (...values: unknown[]) => output(...values.map((value) => (typeof value === 'string' ? value : inspect(value)).split(secret).join('[redacted]')))
}
const f = gitFoundationFixture()
let main: MousseMainService | undefined
let server: MmsProtocolServer | undefined
let client: LocalMmsClient | undefined
let threadId: string | undefined
let phase = 'startup'
const evidence: Record<string, unknown> = { providerId, modelId, credentialSource: 'existing OpenCode auth; memory only', repo: f.repo }
try {
  main = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
  // MutableModels already references this store. Substitute only its credential
  // storage boundary; the provider, transport, model and tools all remain real.
  let credential: Credential | undefined = { type: 'api_key', key: secret }
  const store = main.providerAuth.credentials
  store.read = async (id) => id === providerId ? credential : undefined
  store.get = (id) => id === providerId ? credential : undefined
  store.has = (id) => id === providerId && Boolean(credential)
  store.listProviderIds = () => [providerId]
  store.list = async () => [{ providerId, type: 'api_key' as const }]
  store.modify = async (id, update) => {
    if (id !== providerId) return undefined
    credential = await update(credential)
    return credential
  }
  phase = 'model-inventory'
  await main.providerAuth.refreshDynamicModels()
  const available = main.providerAuth.models.getModels(providerId)
  evidence.deepSeekModels = available.filter((item) => /deepseek/i.test(item.id)).map((item) => ({ id: item.id, name: item.name }))
  if (!available.some((item) => item.id === modelId)) throw new Error('Requested live model not available in Mousse catalog')
  const settings = main.settings.get()
  main.settings.set({ provider: { llmProvider: providerId, model: modelId }, integrations: {
    ...settings.integrations, tools: { enabled: true, enabledTools: ['read', 'write'] },
    skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false }
  } })
  await main.start()
  const token = main.getOwnerLease()!.owner.token
  server = new MmsProtocolServer({ mms: main, ownerToken: token, version: 'live-quality' })
  client = new LocalMmsClient({ homeDir: f.home, endpoint: await server.start(), ownerToken: token, clientType: 'gui' })
  await client.connect()
  const project = main.projects.openProject(f.repo)
  const thread = main.threads.createThread('Bounded live provider verification', project.id)
  threadId = thread.id
  phase = 'live-edit-read'
  await client.request('orchestrator.send', { threadId, mode: 'agent', content:
    'This is a bounded local test. Read value.txt, use write to replace it with exactly live-provider-ok followed by one newline, then read it to verify. Touch no other file. Do not run commands, browse, spawn agents, or use other services. Reply LIVE_EDIT_OK when verified.' }, 120_000)
  const workspace = new ThreadWorkspaceManager(main.threads.getThreadDir(threadId)).load()!.worktreePath
  if (f.read(workspace) !== 'live-provider-ok\n') throw new Error('Live model did not produce exact task bytes')
  evidence.realModelEditedTask = true
  phase = 'undo-redo'
  // Undo the edit while it is the latest turn. A subsequent read-only turn has
  // its own context boundary, so undoing that turn would correctly retain code.
  const status = await client.request<{ journalGeneration: number }>('actions.list', { threadId })
  await client.request('actions.undoLatest', { threadId, expectedJournalGeneration: status.journalGeneration })
  if (f.read(workspace) !== 'base\n') throw new Error('Live action undo did not restore base')
  const undone = await client.request<{ journalGeneration: number }>('actions.list', { threadId })
  await client.request('actions.redo', { threadId, expectedJournalGeneration: undone.journalGeneration })
  if (f.read(workspace) !== 'live-provider-ok\n') throw new Error('Live action redo did not restore model edit')
  evidence.undo = true; evidence.redo = true
  phase = 'read-only-followup'
  await client.request('orchestrator.send', { threadId, mode: 'plan', content:
    'Use read to inspect value.txt without changing any file. Reply LIVE_READ_OK if it contains live-provider-ok. Do not use any other tools or services.' }, 120_000)
  if (!main.orchestrator.getMessages(threadId).some((message) => message.content.includes('LIVE_READ_OK'))) throw new Error('Read-only followup did not verify task bytes')
  evidence.readOnlyFollowup = true
  if (f.read(f.repo) !== 'base\n' || git(f.repo, 'rev-parse', 'HEAD') !== f.baseSha) throw new Error('Primary checkout changed')
  if (!readFileSync(authPath).equals(authBytes)) throw new Error('Saved OpenCode credentials changed during test')
  evidence.primaryPreserved = true; evidence.savedCredentialsUnchanged = true
  evidence.ok = true
} catch (error) {
  evidence.ok = false; evidence.phase = phase
  evidence.error = error instanceof Error ? error.message.split(secret).join('[redacted]') : 'Unknown live-test failure'
  process.exitCode = 1
} finally {
  if (threadId) await client?.request('orchestrator.stop', { threadId }).catch(() => undefined)
  await client?.close(); await server?.stop(); await main?.stop()
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2))
  f.dispose()
}
