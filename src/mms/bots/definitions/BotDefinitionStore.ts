import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_BOT_CONTEXT_THREADS, type BotDefinition, type BotThreadSpec } from '../../../shared/bots/personal/definition'
import { canonicalManifest, manifestProblem } from '../../../shared/bots/personal/manifest'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { stableStringify } from '../../run/json'

/**
 * Bot definitions (PR 6 §4), stored like agent definitions: a draft, and published revisions named
 * by the hash of their content, under `<profileHome>/bots/definitions/<botId>/`. A revision file is
 * written before anything points at it, and is never changed afterwards.
 */

export class BotDefinitionError extends Error {
  constructor(readonly code: 'bot_not_found' | 'bot_invalid' | 'bot_draft_conflict', message: string) {
    super(message)
    this.name = 'BotDefinitionError'
  }
}

const BOT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const HASH = /^[a-f0-9]{64}$/

export function isBotId(value: unknown): value is string {
  return typeof value === 'string' && BOT_ID.test(value)
}

/** Why a definition cannot be published, or undefined when it can. */
export function definitionProblem(definition: BotDefinition): string | undefined {
  if (!isBotId(definition.id)) return 'The bot id is invalid.'
  if (typeof definition.name !== 'string' || !definition.name.trim() || definition.name.length > 120) return 'The bot needs a name.'
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
  if (!definition.triggers || definition.triggers.manual !== true || Object.keys(definition.triggers).some((key) => key !== 'manual'))
    return 'Only manual activation is available yet.'
  return manifestProblem(definition.permissions)
}

function threadProblem(thread: BotThreadSpec): string | undefined {
  if (!thread || typeof thread !== 'object') return 'The bot needs a main thread.'
  if (typeof thread.key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(thread.key)) return 'A thread key is invalid.'
  if (typeof thread.title !== 'string' || !thread.title.trim() || thread.title.length > 120) return 'A thread needs a title.'
  const selection = thread.selection
  if (!selection || typeof selection.instanceId !== 'string' || !selection.instanceId || typeof selection.model !== 'string' || !selection.model)
    return 'Each thread needs a provider and a model.'
  const agent = thread.agent as Partial<{ definitionId: string; instructions: string }> | undefined
  if (!agent || typeof agent !== 'object') return 'Each thread needs instructions.'
  // An agent definition's grants have to fit inside the manifest; that check comes with consults.
  if ('definitionId' in agent) return 'Agent definitions for bot threads are not available yet; use instructions.'
  if (typeof agent.instructions !== 'string' || agent.instructions.length > 64 * 1024) return 'The thread instructions are invalid.'
  return undefined
}

/** SHA-256 (hex) of a definition's canonical content (its revision field left out). */
export function definitionHash(definition: BotDefinition): string {
  const { revision: _revision, ...content } = definition
  return createHash('sha256').update(stableStringify({ ...content, permissions: canonicalManifest(content.permissions) })).digest('hex')
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

  get(botId: string): BotDefinitionEntry | undefined {
    const path = join(this.dir(botId), 'draft.json')
    if (!existsSync(path)) return undefined
    const draft = JSON.parse(readFileSync(path, 'utf8')) as BotDefinition
    const revision = this.published(botId)
    const published = revision ? this.revision(botId, revision) : undefined
    return { id: botId, draft, draftHash: definitionHash(draft), ...(published ? { published } : {}) }
  }

  /** A published revision, by its hash. */
  revision(botId: string, revision: string): BotDefinition | undefined {
    if (!HASH.test(revision)) return undefined
    const path = join(this.dir(botId), 'revisions', `${revision}.json`)
    if (!existsSync(path)) return undefined
    const definition = JSON.parse(readFileSync(path, 'utf8')) as BotDefinition
    return definitionHash(definition) === revision ? { ...definition, revision } : undefined
  }

  /** Saves the draft; `expectedDraftHash` guards against overwriting someone else's edit. */
  save(definition: BotDefinition, expectedDraftHash?: string): BotDefinitionEntry {
    const current = this.get(definition.id)
    if (current && expectedDraftHash !== undefined && current.draftHash !== expectedDraftHash)
      throw new BotDefinitionError('bot_draft_conflict', 'This bot was changed elsewhere. Reload it and try again.')
    const { revision: _revision, ...draft } = definition
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
    const problem = definitionProblem(current.draft)
    if (problem) throw new BotDefinitionError('bot_invalid', problem)
    const revision = current.draftHash
    const dir = join(this.dir(botId), 'revisions')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${revision}.json`)
    if (!existsSync(path)) atomicWriteJsonSync(path, current.draft)
    return { ...current.draft, revision }
  }

  /**
   * Publishes `definition` as a revision without touching the draft ("Allow for this bot"), so
   * the owner's unpublished edits are never overwritten. A definition that cannot run is refused.
   */
  publishRevision(definition: BotDefinition): BotDefinition {
    const { revision: _revision, ...content } = definition
    const problem = definitionProblem(content as BotDefinition)
    if (problem) throw new BotDefinitionError('bot_invalid', problem)
    const revision = definitionHash(content as BotDefinition)
    const dir = join(this.dir(definition.id), 'revisions')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${revision}.json`)
    if (!existsSync(path)) atomicWriteJsonSync(path, content)
    return { ...(content as BotDefinition), revision }
  }

  remove(botId: string): void {
    rmSync(this.dir(botId), { recursive: true, force: true })
  }
}
