import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  BOT_DEFINITION_FORMAT,
  BOT_DEPTHS,
  DEFAULT_BOT_MODEL,
  MAX_BOT_CONTEXT_THREADS,
  MAX_BOT_DESCRIPTION_CHARS,
  MAX_BOT_NAME_CHARS,
  type BotDefinition,
  type BotDefinitionV1,
  type BotModelChoice,
  type BotThreadSpec,
  type BotThreadSpecV1
} from '../../../shared/bots/personal/definition'
import { lookFields, pickDistinctLook, type BotLook } from '../../../shared/bots/personal/look'
import { canonicalManifest, manifestProblem } from '../../../shared/bots/personal/manifest'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { stableStringify } from '../../run/json'

/**
 * Bot definitions (PR 6 §4), stored like agent definitions: a draft, and published revisions named
 * by the hash of their content, under `<profileHome>/bots/definitions/<botId>/`. A revision file is
 * written before anything points at it, and is never changed afterwards.
 *
 * Bot Phase 1 writes format 2 (a look, a description, a hidden model choice). A format-1 file, as
 * the Automations → Bots form wrote it, is upgraded when it is read (§5.2): its revision hash is
 * checked on the file as written, and its schedules move to `bots.db` (`BotEngine.upgradeDefinitions`).
 */

export class BotDefinitionError extends Error {
  constructor(readonly code: 'bot_not_found' | 'bot_invalid' | 'bot_draft_conflict' | 'bot_too_new', message: string) {
    super(message)
    this.name = 'BotDefinitionError'
  }
}

const BOT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const HASH = /^[a-f0-9]{64}$/

export function isBotId(value: unknown): value is string {
  return typeof value === 'string' && BOT_ID.test(value)
}

const isModelChoice = (value: unknown): value is BotModelChoice => {
  const choice = value as Partial<{ mode: unknown; depth: unknown; model: unknown }> | null
  if (!choice || typeof choice !== 'object' || !BOT_DEPTHS.includes(choice.depth as never)) return false
  if (choice.mode === 'auto') return Object.keys(choice).every((key) => key === 'mode' || key === 'depth')
  return choice.mode === 'named' && typeof choice.model === 'string' && choice.model.length > 0 && choice.model.length <= 200 && Object.keys(choice).every((key) => key === 'mode' || key === 'depth' || key === 'model')
}

/** Why a definition cannot be published, or undefined when it can. */
export function definitionProblem(definition: BotDefinition): string | undefined {
  if (definition.format !== BOT_DEFINITION_FORMAT) return 'The bot definition format is not one this build writes.'
  if (!isBotId(definition.id)) return 'The bot id is invalid.'
  if (typeof definition.name !== 'string' || !definition.name.trim() || definition.name.length > MAX_BOT_NAME_CHARS) return 'The bot needs a name.'
  if (typeof definition.description !== 'string' || definition.description.length > MAX_BOT_DESCRIPTION_CHARS) return 'The description is too long.'
  const look = definition.look as Partial<BotLook> | undefined
  if (!look || typeof look.colour !== 'string' || typeof look.accessory !== 'string' || look.colour.length > 40 || look.accessory.length > 40 ||
      (look.kind !== undefined && (typeof look.kind !== 'string' || look.kind.length > 40)) || (look.eyes !== undefined && (typeof look.eyes !== 'string' || look.eyes.length > 40))) return 'The bot needs a look.'
  if (definition.owner?.kind !== 'person' || definition.owner.id !== 'self') return 'Bots for a team are not available yet.'
  if (definition.placement?.kind !== 'this_computer') return 'Bots run on this computer only for now.'
  if (typeof definition.role !== 'string' || definition.role.length > 64 * 1024) return 'The role is invalid.'
  const thread = threadProblem(definition.main)
  if (thread) return thread
  if (!Array.isArray(definition.context)) return 'The context threads are invalid.'
  if (definition.context.length > MAX_BOT_CONTEXT_THREADS) return `A bot can have at most ${MAX_BOT_CONTEXT_THREADS} context threads.`
  const keys = new Set([definition.main.key])
  for (const context of definition.context) {
    const problem = threadProblem(context)
    if (problem) return problem
    if (keys.has(context.key)) return 'Each thread needs its own key.'
    keys.add(context.key)
  }
  // Schedules live in bots.db (`bot_schedules`), never on the definition.
  if (!definition.triggers || definition.triggers.manual !== true || Object.keys(definition.triggers).some((key) => key !== 'manual'))
    return 'A bot is started by its owner or by its schedules.'
  return manifestProblem(definition.permissions)
}

function threadProblem(thread: BotThreadSpec): string | undefined {
  if (!thread || typeof thread !== 'object') return 'The bot needs a main thread.'
  if (typeof thread.key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(thread.key)) return 'A thread key is invalid.'
  if (typeof thread.title !== 'string' || !thread.title.trim() || thread.title.length > 120) return 'A thread needs a title.'
  if (!isModelChoice(thread.model)) return 'Each thread needs a model choice.'
  const agent = thread.agent as Partial<{ definitionId: string; instructions: string }> | undefined
  if (!agent || typeof agent !== 'object') return 'Each thread needs instructions.'
  // An agent definition's grants have to fit inside the manifest; that check comes with consults.
  if ('definitionId' in agent) return 'Agent definitions for bot threads are not available yet; use instructions.'
  if (typeof agent.instructions !== 'string' || agent.instructions.length > 64 * 1024) return 'The thread instructions are invalid.'
  return undefined
}

/** SHA-256 (hex) of a definition's canonical content (its revision field left out); any format. */
export function definitionHash(definition: BotDefinition | BotDefinitionV1): string {
  const { revision: _revision, ...content } = definition
  return createHash('sha256').update(stableStringify({ ...content, permissions: canonicalManifest(content.permissions) })).digest('hex')
}

const threadV2 = (thread: BotThreadSpecV1): BotThreadSpec => {
  const { selection: _selection, ...rest } = thread
  return { ...rest, model: { ...DEFAULT_BOT_MODEL } }
}

/**
 * A format-1 definition as format 2 (§5.2): the description is the role's first line, the model is
 * automatic at normal depth (the old selection is dropped), and schedules leave the definition. The
 * manifest is unchanged, so the grant's digest stays valid.
 */
export function upgradeDefinitionV1(v1: BotDefinitionV1, look: BotLook): BotDefinition {
  const firstLine = (v1.role ?? '').trim().split('\n')[0]?.trim() ?? ''
  return {
    format: 2,
    id: v1.id,
    ...(v1.revision ? { revision: v1.revision } : {}),
    name: (v1.name ?? '').trim().slice(0, MAX_BOT_NAME_CHARS) || 'Bot',
    description: firstLine.slice(0, MAX_BOT_DESCRIPTION_CHARS),
    look: lookFields(look),
    owner: { kind: 'person', id: 'self' },
    placement: { kind: 'this_computer' },
    role: v1.role ?? '',
    main: threadV2(v1.main),
    context: (v1.context ?? []).map(threadV2),
    permissions: v1.permissions,
    triggers: { manual: true }
  }
}

/** Format 1 has no `format` field; a later format is refused (fail closed, like a newer `bots.db`). */
function formatOf(raw: unknown): 1 | 2 {
  const format = (raw as { format?: unknown } | null)?.format
  if (format === undefined) return 1
  if (format === BOT_DEFINITION_FORMAT) return 2
  throw new BotDefinitionError('bot_too_new', 'This bot was made by a newer Mousse.')
}

/** A random-number source fixed by `seed`, so an upgraded bot's look is the same on every read. */
function seeded(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0)
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface BotDefinitionEntry {
  id: string
  draft: BotDefinition
  draftHash: string
  /** The published revision, when there is one. */
  published?: BotDefinition
}

export class BotDefinitionStore {
  private readonly root: string

  /** `botsDirectory`: `<profileHome>/bots`. `published` reads the published pointer (`bots.db`). */
  constructor(botsDirectory: string, private readonly published: (botId: string) => string | null) {
    this.root = join(botsDirectory, 'definitions')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  private dir(botId: string): string {
    if (!isBotId(botId)) throw new BotDefinitionError('bot_invalid', 'The bot id is invalid.')
    return join(this.root, botId)
  }

  ids(): string[] {
    return readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && isBotId(entry.name) && existsSync(join(this.root, entry.name, 'draft.json'))).map((entry) => entry.name).sort()
  }

  private readRaw(path: string): BotDefinition | BotDefinitionV1 {
    return JSON.parse(readFileSync(path, 'utf8')) as BotDefinition | BotDefinitionV1
  }

  /** The draft as written, in either format (the upgrade reads format 1's schedules from it). */
  rawDraft(botId: string): BotDefinition | BotDefinitionV1 | undefined {
    const path = join(this.dir(botId), 'draft.json')
    return existsSync(path) ? this.readRaw(path) : undefined
  }

  /** A published revision as written, checked against its hash, in either format. */
  rawRevision(botId: string, revision: string): BotDefinition | BotDefinitionV1 | undefined {
    if (!HASH.test(revision)) return undefined
    const path = join(this.dir(botId), 'revisions', `${revision}.json`)
    if (!existsSync(path)) return undefined
    const definition = this.readRaw(path)
    return definitionHash(definition) === revision ? { ...definition, revision } : undefined
  }

  /**
   * The look a format-1 bot gets: one the owner's other bots don't wear yet, the same on every read
   * (until the upgrade writes it back).
   */
  private upgradeLook(botId: string): BotLook {
    const others: BotLook[] = []
    for (const id of this.ids()) {
      if (id === botId) continue
      try {
        const raw = this.rawDraft(id)
        if (raw && formatOf(raw) === 2) others.push((raw as BotDefinition).look)
      } catch {
        // A bot this build cannot read takes no part.
      }
    }
    return pickDistinctLook(others, seeded(botId))
  }

  private upgraded(raw: BotDefinition | BotDefinitionV1, look: () => BotLook): BotDefinition {
    return formatOf(raw) === 2 ? (raw as BotDefinition) : upgradeDefinitionV1(raw as BotDefinitionV1, look())
  }

  /** Whether the bot's draft is still format 1 (the upgrade has not written it back). */
  isFormat1(botId: string): boolean {
    const raw = this.rawDraft(botId)
    return raw !== undefined && formatOf(raw) === 1
  }

  get(botId: string): BotDefinitionEntry | undefined {
    const raw = this.rawDraft(botId)
    if (!raw) return undefined
    const draft = this.upgraded(raw, () => this.upgradeLook(botId))
    const revision = this.published(botId)
    const published = revision ? this.revision(botId, revision) : undefined
    return { id: botId, draft, draftHash: definitionHash(draft), ...(published ? { published } : {}) }
  }

  /** A published revision, by its hash, as format 2 (a format-1 revision wears its bot's look). */
  revision(botId: string, revision: string): BotDefinition | undefined {
    const raw = this.rawRevision(botId, revision)
    if (!raw) return undefined
    return { ...this.upgraded(raw, () => this.lookOf(botId)), revision }
  }

  private lookOf(botId: string): BotLook {
    try {
      const raw = this.rawDraft(botId)
      if (raw && formatOf(raw) === 2) return (raw as BotDefinition).look
    } catch {
      // Below.
    }
    return this.upgradeLook(botId)
  }

  /** Saves the draft; `expectedDraftHash` guards against overwriting someone else's edit. */
  save(definition: BotDefinition, expectedDraftHash?: string): BotDefinitionEntry {
    const current = this.get(definition.id)
    if (current && expectedDraftHash !== undefined && current.draftHash !== expectedDraftHash)
      throw new BotDefinitionError('bot_draft_conflict', 'This bot was changed elsewhere. Reload it and try again.')
    const { revision: _revision, ...given } = definition
    // Permissions are stored in their one canonical form (per-folder access included).
    const draft = given.permissions && typeof given.permissions === 'object' && !manifestProblem(given.permissions) ? { ...given, permissions: canonicalManifest(given.permissions) } : given
    mkdirSync(this.dir(definition.id), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(join(this.dir(definition.id), 'draft.json'), draft)
    return this.get(definition.id)!
  }

  /**
   * Writes the draft as a published revision and returns it; the caller then points the registry
   * at it. A definition that cannot run is refused.
   */
  publish(botId: string, expectedDraftHash: string): BotDefinition {
    const current = this.get(botId)
    if (!current) throw new BotDefinitionError('bot_not_found', 'No bot with that id.')
    if (current.draftHash !== expectedDraftHash) throw new BotDefinitionError('bot_draft_conflict', 'This bot was changed elsewhere. Reload it and try again.')
    return this.publishRevision(current.draft)
  }

  /**
   * Publishes `definition` as a revision without touching the draft ("Allow for this bot"), so
   * the owner's unpublished edits are never overwritten. A definition that cannot run is refused.
   */
  publishRevision(definition: BotDefinition): BotDefinition {
    const { revision: _revision, ...given } = definition
    const content = { ...given, permissions: canonicalManifest(given.permissions) } as BotDefinition
    const problem = definitionProblem(content)
    if (problem) throw new BotDefinitionError('bot_invalid', problem)
    const revision = definitionHash(content)
    const dir = join(this.dir(definition.id), 'revisions')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${revision}.json`)
    if (!existsSync(path)) atomicWriteJsonSync(path, content)
    return { ...content, revision }
  }

  remove(botId: string): void {
    rmSync(this.dir(botId), { recursive: true, force: true })
  }
}
