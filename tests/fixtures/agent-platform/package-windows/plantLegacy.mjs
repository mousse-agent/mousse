/**
 * Plant a legacy (pre-profile) personal config + thread + shared credential
 * layout under an isolated MOUSSE_HOME. Does not touch the user's ~/.mousse.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Matches src/shared/profiles/fixtures.ts FIXTURE_LEGACY_MOUSSE_CONF. */
export const LEGACY_MOUSSE_CONF = {
  version: 1,
  mms: { autostart: false, logLevel: 'info' },
  features: { subagentLifecycleV2: false },
  settings: {
    profile: { username: 'legacy-user' },
    appearance: { theme: 'dark', accentColor: '#3b82f6', acrylic: false, acrylicIntensity: 50 },
    notifications: { threadCompletionSound: true }
  },
  providers: { llmProvider: 'openrouter', model: 'openai/gpt-4.1' },
  agents: { enabled: { mousse: true } },
  scheduled: {
    enabled: true,
    jobs: [
      {
        id: 'job-1',
        name: 'Morning',
        prompt: 'status',
        schedule: { kind: 'once', runAt: '2099-01-01T09:00:00.000Z' },
        enabled: false,
        state: 'paused',
        nextRunAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
  },
  channels: { platforms: { webhook: { enabled: false } } },
  experimentalUnknown: { keep: true }
}

export const LEGACY_THREAD_ID = 'q04-legacy-thread'
export const LEGACY_AUTH_PROVIDER = 'openai'
export const LEGACY_AUTH_KEY = 'q04-fixture-not-a-live-key'

export function plantLegacyHome(homeDir, options = {}) {
  if (!homeDir || typeof homeDir !== 'string') {
    throw new Error('plantLegacyHome requires an absolute homeDir')
  }
  const threadId = options.threadId || LEGACY_THREAD_ID
  const authKey = options.authKey || LEGACY_AUTH_KEY
  const meta = { id: threadId, name: 'Q04 legacy thread', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', order: 0 }
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(
    join(homeDir, 'auth.json'),
    JSON.stringify({ [LEGACY_AUTH_PROVIDER]: { type: 'api_key', key: authKey } }, null, 2)
  )
  writeFileSync(join(homeDir, 'mousse.conf'), JSON.stringify(LEGACY_MOUSSE_CONF, null, 2))
  writeFileSync(
    join(homeDir, 'threads-index.json'),
    JSON.stringify([meta], null, 2)
  )
  writeFileSync(join(homeDir, 'active-thread.json'), JSON.stringify({ id: threadId }, null, 2))
  const threadDir = join(homeDir, 'thread-data', 'standalone', threadId)
  mkdirSync(threadDir, { recursive: true })
  writeFileSync(join(threadDir, 'meta.json'), JSON.stringify(meta))
  for (const name of ['messages', 'agents', 'tasks']) writeFileSync(join(threadDir, name + '.json'), '[]')
  writeFileSync(
    join(threadDir, 'transcript.json'),
    JSON.stringify({ id: threadId, title: 'Q04 legacy thread', fixture: true }, null, 2)
  )
  return {
    homeDir,
    threadId,
    authPath: join(homeDir, 'auth.json'),
    confPath: join(homeDir, 'mousse.conf'),
    transcriptPath: join(threadDir, 'transcript.json')
  }
}
