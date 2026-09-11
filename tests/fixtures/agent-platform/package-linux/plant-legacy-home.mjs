/**
 * Plants a disposable pre-profile MOUSSE_HOME for Linux packaged/CLI qualification.
 * Does not write live owner/runtime records. Does not touch ~/.mousse.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LEGACY_MOUSSE_CONF = {
  version: 1,
  mms: { autostart: false, logLevel: 'info' },
  features: { subagentLifecycleV2: false },
  settings: {
    profile: { username: 'linux-qual-legacy' },
    appearance: { theme: 'dark', accentColor: '#3b82f6', acrylic: false, acrylicIntensity: 50 },
    notifications: { threadCompletionSound: true }
  },
  providers: { llmProvider: 'openrouter', model: 'openai/gpt-4.1' },
  agents: { enabled: { mousse: true } },
  scheduled: { enabled: true, jobs: [{ id: 'job-1', name: 'Morning', prompt: 'status', schedule: { kind: 'once', runAt: '2099-01-01T00:00:00.000Z' }, enabled: false, state: 'paused', nextRunAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] },
  channels: { platforms: { webhook: { enabled: false } } },
  experimentalUnknown: { keep: true }
}

export function plantLegacyHome(homeDir) {
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(join(homeDir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'shared-not-live' } }))
  writeFileSync(join(homeDir, 'mousse.conf'), JSON.stringify(LEGACY_MOUSSE_CONF, null, 2))
  writeFileSync(join(homeDir, 'projects.json'), JSON.stringify([{ id: 'proj-1', path: join(homeDir, '..', 'repo') }]))
  const meta = { id: 'thread-1', name: 'Hello Linux', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', order: 0 }
  writeFileSync(join(homeDir, 'threads-index.json'), JSON.stringify([meta]))
  writeFileSync(join(homeDir, 'active-thread.json'), JSON.stringify({ id: 'thread-1' }))
  mkdirSync(join(homeDir, 'thread-data', 'standalone', 'thread-1'), { recursive: true })
  writeFileSync(join(homeDir, 'thread-data', 'standalone', 'thread-1', 'meta.json'), JSON.stringify(meta))
  for (const name of ['messages', 'agents', 'tasks']) writeFileSync(join(homeDir, 'thread-data', 'standalone', 'thread-1', name + '.json'), '[]')
  writeFileSync(
    join(homeDir, 'thread-data', 'standalone', 'thread-1', 'transcript.json'),
    JSON.stringify({ id: 'thread-1' })
  )
  mkdirSync(join(homeDir, 'scheduled'), { recursive: true })
  writeFileSync(join(homeDir, 'scheduled', 'jobs-runtime.json'), JSON.stringify({ 'job-1': { state: 'idle' } }))
  mkdirSync(join(homeDir, 'channels'), { recursive: true })
  // Production ChannelStore.listSessions() JSON.parse-casts an array. An object
  // map throws `sessions is not iterable` during MMS start and leaves the owner
  // lease held. Keep the array shape used by the live store.
  writeFileSync(join(homeDir, 'channels', 'sessions.json'), JSON.stringify([]))
  mkdirSync(join(homeDir, 'mcp-oauth'), { recursive: true })
  writeFileSync(join(homeDir, 'mcp-oauth', 'session.json'), JSON.stringify({ token: 'mcp-not-live' }))
  mkdirSync(join(homeDir, 'repositories', 'repoaaaa', 'worktrees', 'threads', 'thread-1'), { recursive: true })
  writeFileSync(
    join(homeDir, 'repositories', 'repoaaaa', 'worktrees', 'threads', 'thread-1', '.git'),
    'gitdir: /tmp/mousse-linux-qual-fake.git/worktrees/thread-1\n'
  )
  return homeDir
}

const isMain = process.argv[1] && process.argv[1].endsWith('plant-legacy-home.mjs')
if (isMain) {
  const home = process.argv[2]
  if (!home) {
    process.stderr.write('usage: plant-legacy-home.mjs <absolute-home>\n')
    process.exit(2)
  }
  plantLegacyHome(home)
  process.stdout.write(`${home}\n`)
}
