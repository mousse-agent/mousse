/**
 * Bot Phase 1 §5.1.2 and §5.2: `bots.db` v3 → v4. A `VACUUM INTO` copy is made first (the last two
 * are kept); open escalations of the form editor are withdrawn and their waits end; the new tables
 * exist, with at most one open ask per permission. Format-1 definitions are upgraded on read and
 * once at open: their schedules move to `bot_schedules`, the grant digest still holds, and a draft
 * that was never published is published with the starter grant, approved on first chat.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { starterManifest } from '../../src/mms/bots/chat/projection'
import { BotDefinitionStore, definitionHash } from '../../src/mms/bots/definitions/BotDefinitionStore'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { BOTS_MIGRATIONS, BotStore } from '../../src/mms/bots/store/BotStore'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import type { BotDefinitionV1, BotManifest } from '../../src/shared/bots/personal/definition'
import { manifestSubset } from '../../src/shared/bots/personal/manifest'

let base: string
let profile: string
let root: string
let store: BotStore | undefined

const T = '2026-11-01T08:00:00.000Z'

const manifest = (): BotManifest => ({
  tools: ['read', 'search'],
  appTools: ['web_search'],
  mcp: [],
  skills: [],
  workspace: { roots: [root], access: 'read' },
  budget: { maxActiveMs: 10 * 60_000 },
  audience: 'owner'
})

const v1 = (id: string, patch: Partial<BotDefinitionV1> = {}): BotDefinitionV1 => ({
  id,
  name: 'Site editor',
  role: 'You keep the site tidy.\nFix broken links first.',
  main: { key: 'main', title: 'Main', agent: { instructions: 'Answer briefly.' }, selection: { instanceId: 'pi:openrouter', model: 'some/model' } },
  context: [],
  permissions: manifest(),
  triggers: { manual: true, schedules: [{ id: 'tidy', when: { kind: 'interval', minutes: 60 }, prompt: 'Tidy the site.' }] },
  ...patch
})

const definitionsDir = () => join(profile, 'bots', 'definitions')

function writeDefinition(id: string, draft: object, revision?: object): string | undefined {
  const dir = join(definitionsDir(), id)
  mkdirSync(join(dir, 'revisions'), { recursive: true })
  writeFileSync(join(dir, 'draft.json'), JSON.stringify(draft))
  if (!revision) return undefined
  const hash = definitionHash(revision as BotDefinitionV1)
  writeFileSync(join(dir, 'revisions', `${hash}.json`), JSON.stringify(revision))
  return hash
}

/** A v3 `bots.db` as the form editor's build left it: one published, approved bot with an open wall. */
function buildV3(): { revision: string; digest: string } {
  const db = new ProfileDatabase({ profileHome: profile, name: 'bots' })
  db.migrate(BOTS_MIGRATIONS.slice(0, 3))
  const published = v1('site-editor')
  const revision = writeDefinition('site-editor', published, published)!
  const digest = botManifestDigest(published.permissions)
  const run = (sql: string, ...params: Array<string | number | null>) => db.statement(sql).run(...params)
  run('INSERT INTO bot_registry(bot_id, revision, home_thread_id, created_at) VALUES(?, ?, ?, ?)', 'site-editor', revision, 'thread:bot:site-editor', T)
  run('INSERT INTO bot_grants(bot_id, digest, manifest_json, approved_at) VALUES(?, ?, ?, ?)', 'site-editor', digest, JSON.stringify(published.permissions), T)
  run("INSERT INTO bot_activations(id, bot_id, revision, grant_digest, trigger_json, idempotency_key, status, created_at) VALUES(?, ?, ?, ?, ?, ?, 'waiting_grant', ?)",
    'act_1', 'site-editor', revision, digest, JSON.stringify({ kind: 'manual', input: 'go' }), 'manual:c1', T)
  run("INSERT INTO bot_escalations(id, activation_id, dispatch_n, kind, permission_json, reason, status, created_at, expires_at) VALUES(?, ?, 1, 'gate', ?, 'needs it', 'open', ?, ?)",
    'esc_1', 'act_1', JSON.stringify({ tool: 'edit' }), T, '2026-11-01T08:30:00.000Z')
  run("INSERT INTO bot_escalations(id, activation_id, dispatch_n, kind, permission_json, reason, status, created_at, expires_at, answered_at) VALUES(?, ?, 1, 'gate', ?, 'old', 'denied', ?, ?, ?)",
    'esc_0', 'act_1', JSON.stringify({ tool: 'write' }), T, '2026-11-01T08:30:00.000Z', T)
  run('INSERT INTO bot_schedule_state(bot_id, schedule_id, spec_json, next_run_at) VALUES(?, ?, ?, ?)', 'site-editor', 'tidy', JSON.stringify({ kind: 'interval', minutes: 60 }), '2026-11-07T10:00:00.000Z')
  db.close()
  return { revision, digest }
}

function engineFor(opened: BotStore): BotEngine {
  const definitions = new BotDefinitionStore(opened.directory, (botId) => opened.registry(botId)?.revision ?? null)
  return new BotEngine({
    profileHome: profile,
    store: opened,
    definitions,
    threads: { ensureExecutionThread: (key) => ({ id: `thread:${key}` }) },
    runs: () => null,
    harness: { checkPolicy: () => ({ ok: true }), nativeToolNames: (_instanceId, tools) => ({ ok: true, names: [...tools] }) },
    notifyEffects: () => {}
  })
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bots-v4-')))
  profile = join(base, 'profile')
  root = join(base, 'site')
  mkdirSync(profile, { recursive: true })
  mkdirSync(root, { recursive: true })
  store = undefined
})

afterEach(() => {
  store?.close()
  rmSync(base, { recursive: true, force: true })
})

describe('bots.db v3 → v4', () => {
  it('copies the database first, withdraws open escalations, and adds the Phase 1 tables', () => {
    buildV3()
    store = new BotStore({ profileHome: profile })
    const copy = join(profile, 'bots', 'bots.db.pre-v4')
    expect(existsSync(copy)).toBe(true)
    const old = new DatabaseSync(copy)
    try {
      expect(Number(old.prepare('PRAGMA user_version').get()!.user_version)).toBe(3)
      expect(old.prepare("SELECT status FROM bot_escalations WHERE id = 'esc_1'").get()).toEqual({ status: 'open' })
    } finally {
      old.close()
    }
    expect(store.db.userVersion()).toBe(4)
    expect(store.escalation('esc_1')).toMatchObject({ botId: 'site-editor', status: 'withdrawn', mode: 'wall', answeredAt: expect.any(String) })
    expect(store.escalation('esc_0')).toMatchObject({ status: 'denied' })
    expect(store.activation('act_1')).toMatchObject({ status: 'cancelled', endReason: 'bots_upgraded', lane: 'run' })
    expect(store.registry('site-editor')).toMatchObject({ pausedReason: null, failureStreak: 0, error: null, readSeq: 0, model: null })
    for (const table of ['bot_messages', 'bot_schedules'])
      expect(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table)).toEqual({ name: table })
  })

  it('asks never expire, and a bot has at most one open ask per fingerprint', () => {
    buildV3()
    store = new BotStore({ profileHome: profile })
    const ask = (id: string) => ({
      id, botId: 'site-editor', activationId: 'act_1', dispatchN: 1, toolCallId: null, kind: 'gate' as const, permission: { tool: 'edit' }, reason: 'r',
      createdAt: T, expiresAt: null, mode: 'ask' as const, fingerprint: '{"tool":"edit"}', title: 'use edit', note: '', messageId: null
    })
    expect(store.insertEscalation(ask('esc_a'))).toBe(true)
    expect(store.insertEscalation(ask('esc_b'))).toBe(false)
    expect(store.escalation('esc_a')).toMatchObject({ expiresAt: null, status: 'open' })
    // Once answered, the permission may be asked for again.
    expect(store.answerEscalation('esc_a', 'denied')).toBe(true)
    expect(store.insertEscalation(ask('esc_b'))).toBe(true)
  })

  it('keeps the last two copies', () => {
    buildV3()
    const dir = join(profile, 'bots')
    writeFileSync(join(dir, 'bots.db.pre-v2'), 'old')
    writeFileSync(join(dir, 'bots.db.pre-v3'), 'older build')
    store = new BotStore({ profileHome: profile })
    expect(existsSync(join(dir, 'bots.db.pre-v4'))).toBe(true)
    expect(existsSync(join(dir, 'bots.db.pre-v3'))).toBe(true)
    expect(existsSync(join(dir, 'bots.db.pre-v2'))).toBe(false)
  })

  it('makes no copy for a new database', () => {
    store = new BotStore({ profileHome: profile })
    expect(existsSync(join(profile, 'bots', 'bots.db.pre-v4'))).toBe(false)
  })
})

describe('definitions format 1 → 2', () => {
  it('upgrades a published bot once: schedules move to bot_schedules, the grant still holds', () => {
    const { revision, digest } = buildV3()
    store = new BotStore({ profileHome: profile })
    const engine = engineFor(store)
    // Read through the upgrade before it is written back.
    const read = new BotDefinitionStore(store.directory, (botId) => store!.registry(botId)?.revision ?? null).revision('site-editor', revision)
    expect(read).toMatchObject({ format: 2, description: 'You keep the site tidy.', main: { model: { mode: 'auto', depth: 'normal' } }, triggers: { manual: true } })
    expect(read?.main).not.toHaveProperty('selection')
    engine.upgradeDefinitions()
    const entry = engine.get('site-editor')
    const published = entry.published!
    expect(published).toMatchObject({
      format: 2,
      name: 'Site editor',
      description: 'You keep the site tidy.',
      owner: { kind: 'person', id: 'self' },
      placement: { kind: 'this_computer' },
      role: 'You keep the site tidy.\nFix broken links first.',
      main: { key: 'main', model: { mode: 'auto', depth: 'normal' } },
      triggers: { manual: true }
    })
    expect(published.look).toEqual({ colour: expect.any(String), accessory: expect.any(String) })
    expect(entry.draft).toMatchObject({ format: 2, look: published.look })
    expect(published.revision).not.toBe(revision)
    expect(store.registry('site-editor')?.revision).toBe(published.revision)
    // The manifest is unchanged: the same grant, no re-approval.
    const grant = store.activeGrant('site-editor')!
    expect(grant.digest).toBe(digest)
    expect(botManifestDigest(published.permissions)).toBe(digest)
    expect(manifestSubset(published.permissions, grant.manifest)).toBe(true)
    expect(store.schedules('site-editor')).toMatchObject([{ id: 'tidy', when: { kind: 'interval', minutes: 60 }, prompt: 'Tidy the site.', createdBy: 'owner' }])
    // Same id: the schedule's next-run state still matches it.
    expect(store.scheduleStates('site-editor').map((state) => state.scheduleId)).toEqual(['tidy'])
    expect(engine.get('site-editor').draft.look).toEqual(published.look)
    // Once: a second pass changes nothing.
    engine.upgradeDefinitions()
    expect(store.registry('site-editor')?.revision).toBe(published.revision)
    expect(store.schedules('site-editor')).toHaveLength(1)
  })

  it('a draft never published is published with the starter grant only and approved on first chat', () => {
    store = new BotStore({ profileHome: profile })
    writeDefinition('draft-bot', v1('draft-bot', { name: 'Draft', permissions: { ...manifest(), tools: ['read', 'edit', 'shell'] } }))
    const engine = engineFor(store)
    engine.upgradeDefinitions()
    const published = engine.get('draft-bot').published!
    expect(published).toMatchObject({ format: 2, name: 'Draft' })
    expect(botManifestDigest(published.permissions)).toBe(botManifestDigest(starterManifest()))
    expect(store.activeGrant('draft-bot')).toBeUndefined()
    engine.approveStarterIfNeeded('draft-bot')
    expect(store.activeGrant('draft-bot')?.digest).toBe(botManifestDigest(starterManifest()))
  })

  it('a definition made by a newer Mousse is refused', () => {
    store = new BotStore({ profileHome: profile })
    writeDefinition('future-bot', { ...v1('future-bot'), format: 3 })
    const definitions = new BotDefinitionStore(store.directory, () => null)
    expect(() => definitions.get('future-bot')).toThrow('This bot was made by a newer Mousse.')
    // The upgrade leaves it alone; the other bots are not affected.
    expect(() => engineFor(store!).upgradeDefinitions()).not.toThrow()
  })
})
