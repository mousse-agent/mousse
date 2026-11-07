import { randomUUID } from 'node:crypto'
import type { BotChatMessage, BotChip, BotDetail, BotSummary } from '../../../shared/bots/personal/chat'
import { DEFAULT_BOT_MODEL, MAX_BOT_DESCRIPTION_CHARS, MAX_BOT_NAME_CHARS, type BotDefinition } from '../../../shared/bots/personal/definition'
import { normalizeBotLook, type BotLook } from '../../../shared/bots/personal/look'
import type { BotMemoryForgetResult, BotMemoryListing } from '../../../shared/bots/personal/memory'
import { MAX_BOT_CHAT_PAGE, type BotChatAttachment } from '../../../shared/bots/personal/methods'
import { BotEngineError, type BotEngine } from '../activation/BotEngine'
import type { BotMemoryAdmin } from '../seams'
import type { BotStore } from '../store/BotStore'
import { grantedPermissions, permissionId, starterManifest, withoutPermission } from './projection'

/**
 * The Bot UI's daemon side (Bot Phase 1 §5.3, §5.11): create a bot from a look and a sentence,
 * chat with it, answer its asks, and manage it from its menu and About. Every result is built from
 * `bots.db` by the projection, so no model or instance id reaches a client.
 */

/** How long naming a new bot may take before the description names it (§5.3.1). */
export const BOT_NAMING_TIMEOUT_MS = 5_000

/** Words a name is never made of. */
const FILLER = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'and', 'or', 'me', 'my', 'i', 'you', 'your', 'it', 'its', 'in', 'on', 'at', 'by', 'with', 'from',
  'every', 'each', 'this', 'that', 'these', 'those', 'please', 'can', 'could', 'would', 'will', 'should', 'do', 'does', 'help', 'helps',
  'helper', 'bot', 'who', 'which', 'what', 'when', 'is', 'are', 'be', 'some', 'any', 'all', 'about', 'into', 'up', 'out', 'so', 'just', 'us', 'our'
])

const titleCase = (words: readonly string[]): string => words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ')

/** A name from the description alone: its first three different meaningful words, in title case. */
export function fallbackBotName(description: string): string {
  const words = description.split(/[^\p{L}\p{N}'-]+/u).map((word) => word.replace(/^['-]+|['-]+$/g, '')).filter((word) => word && !FILLER.has(word.toLowerCase()))
  // "the notes in my Notes folder" says "Notes" once.
  const distinct = words.filter((word, at) => words.findIndex((other) => other.toLowerCase() === word.toLowerCase()) === at)
  return titleCase(distinct.slice(0, 3)).slice(0, MAX_BOT_NAME_CHARS) || 'New Bot'
}

/** A model's naming answer as a name: its first line, without quotes or a trailing stop, in title case, at most four words. */
export function cleanBotName(answer: string): string | undefined {
  const line = answer.trim().split('\n').find((part) => part.trim())?.trim() ?? ''
  const words = line.replace(/^(name|title)\s*:\s*/i, '').replace(/["'`*_“”‘’.!?:;]/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 4) return undefined
  const name = titleCase(words)
  return name.length <= MAX_BOT_NAME_CHARS ? name : undefined
}

/** The input of a new bot's first chat activation (§5.3.1, step 6). */
export function firstMessagePrompt(description: string): string {
  return `[Mousse] The owner just created you. Their description: "${description}". In one or two sentences say what you understood. If you will need a permission, ask for the first one now (escalate). If the description is unclear, ask one question instead.`
}

/** A chat message as the bot's input: the owner's text, and the files attached to it. */
function chatInput(text: string, attachments: readonly BotChatAttachment[] | undefined): string {
  if (!attachments?.length) return text
  return `${text}\n\nAttached files:\n${attachments.map((file) => `- ${file.name}: ${file.path}`).join('\n')}`
}

export class BotChatService {
  constructor(private readonly engine: BotEngine, private readonly options: {
    store: BotStore
    memory?: BotMemoryAdmin
    now(): number
  }) {}

  private get store(): BotStore {
    return this.options.store
  }

  private summaryOf(botId: string): BotSummary {
    return this.engine.chat.summary(this.engine.definitionOf(botId), this.options.now())
  }

  private detailOf(botId: string): BotDetail {
    return this.engine.chat.detail(this.engine.definitionOf(botId), this.options.now())
  }

  /** `bots.personal.list`: every bot that is not deleted, oldest first. */
  list(): { bots: BotSummary[] } {
    return { bots: this.engine.botIds().map((botId) => this.summaryOf(botId)) }
  }

  get(botId: string): BotDetail {
    return this.detailOf(botId)
  }

  /**
   * `bots.create` (§5.3.1): validates, names the bot (or uses the given name), writes and approves
   * its starter grant, makes its home thread and files folder, and starts its first chat
   * activation, whose reply is its first message. A repeat of `clientRequestId` returns the same bot.
   */
  async create(input: { look: BotLook; name?: string; description: string; clientRequestId: string }): Promise<{ bot: BotSummary }> {
    const description = input.description.trim()
    if (!description || description.length > MAX_BOT_DESCRIPTION_CHARS) throw new BotEngineError('invalid_params', `Say what the bot should do in 1 to ${MAX_BOT_DESCRIPTION_CHARS} characters.`)
    const given = input.name?.trim()
    if (input.name !== undefined && given && given.length > MAX_BOT_NAME_CHARS) throw new BotEngineError('invalid_params', `A name is at most ${MAX_BOT_NAME_CHARS} characters.`)
    const key = `create:${input.clientRequestId}`
    const made = this.store.activationByKey(key)
    if (made) return { bot: this.summaryOf(made.botId) }
    // The first bot of an owner with a Claude subscription adds "Claude for bots" (§5.9 item 7).
    await this.engine.prepareBotRunner()
    const botId = `bot-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const name = given || (await this.nameFor(botId, description))
    const definition: BotDefinition = {
      format: 2,
      id: botId,
      name,
      description,
      look: normalizeBotLook(input.look),
      owner: { kind: 'person', id: 'self' },
      placement: { kind: 'this_computer' },
      role: description,
      main: { key: 'main', title: 'Main', agent: { instructions: '' }, model: { ...DEFAULT_BOT_MODEL } },
      context: [],
      permissions: starterManifest(),
      triggers: { manual: true }
    }
    // A duplicate create in flight at the same time found nothing yet: the first one wins.
    const raced = this.store.activationByKey(key)
    if (raced) return { bot: this.summaryOf(raced.botId) }
    this.engine.createBot(definition)
    await this.engine.enqueueChat(botId, key, firstMessagePrompt(description))
    return { bot: this.summaryOf(botId) }
  }

  /** The bot names itself on its own model (`harness.oneShot`); on a failure or after 5 seconds the description names it. */
  private async nameFor(botId: string, description: string): Promise<string> {
    const fallback = fallbackBotName(description)
    const answer = await this.engine.oneShotFor(botId, `Two or three words naming a helper that does: ${description}\nAnswer with the name only, in plain title case.`, BOT_NAMING_TIMEOUT_MS)
    return (answer && cleanBotName(answer)) || fallback
  }

  /** `bots.update`: rename or change look; a new revision with the same manifest (no approval). */
  update(botId: string, change: { name?: string; look?: BotLook }): { bot: BotSummary } {
    if (change.name === undefined && change.look === undefined) throw new BotEngineError('invalid_params', 'Nothing to change.')
    this.engine.setProfile(botId, { ...(change.name !== undefined ? { name: change.name } : {}), ...(change.look ? { look: normalizeBotLook(change.look) } : {}) })
    return { bot: this.summaryOf(botId) }
  }

  /** `bots.personal.pause`: its schedules stop; chat still works. */
  pause(botId: string): { bot: BotSummary } {
    this.engine.pauseBot(botId)
    return { bot: this.summaryOf(botId) }
  }

  /** `bots.personal.resume`: clears the pause (the owner's, three failures, or a usage limit), the failure streak and the stuck error. */
  async resume(botId: string): Promise<{ bot: BotSummary }> {
    await this.engine.resumeBot(botId)
    return { bot: this.summaryOf(botId) }
  }

  /** `bots.delete`: archived now, purged after 30 days. */
  delete(botId: string): Promise<{ purgeAt: string }> {
    return this.engine.remove(botId)
  }

  /** `bots.chat.list`: a page of the chat (oldest first), and the live chip of a working activation. */
  chatList(botId: string, page: { beforeSeq?: number; limit?: number } = {}): { messages: BotChatMessage[]; live?: { activationId: string; chip?: BotChip } } {
    this.engine.definitionOf(botId)
    const limit = Math.max(1, Math.min(MAX_BOT_CHAT_PAGE, page.limit ?? 50))
    const messages = this.store.messages(botId, { ...(page.beforeSeq !== undefined ? { beforeSeq: page.beforeSeq } : {}), limit }).map((row) => this.engine.chat.toMessage(row))
    const live = this.engine.liveActivity(botId)
    return { messages, ...(live ? { live } : {}) }
  }

  /**
   * `bots.chat.send` (§5.3.2): the owner's row and its journal row first, in one transaction
   * (idempotent on `clientRequestId`); then a chat waiting at a wall continues with this message
   * (its asks count as Not now), or a chat activation is queued behind the lane.
   */
  async chatSend(input: { botId: string; text: string; attachments?: BotChatAttachment[]; clientRequestId: string }): Promise<{ message: BotChatMessage }> {
    const definition = this.engine.definitionOf(input.botId)
    const text = input.text.trim()
    if (!text) throw new BotEngineError('invalid_params', 'The message is empty.')
    const existing = this.store.messageByRequest(input.clientRequestId)
    if (existing) {
      if (existing.botId !== input.botId) throw new BotEngineError('client_request_id_conflict', 'This request belongs to another bot.')
      return { message: this.engine.chat.toMessage(existing) }
    }
    // The activation this message belongs to: its row and journal row say so (the chat pack then
    // leaves it out, as it is the request).
    const target = this.engine.chatActivationFor(input.botId)
    let message: BotChatMessage
    try {
      message = this.engine.chat.post({
        botId: input.botId,
        author: 'owner',
        kind: 'text',
        text,
        ...(input.attachments?.length ? { attachments: input.attachments.map((file) => ({ name: file.name, path: file.path })) } : {}),
        clientRequestId: input.clientRequestId,
        activationId: target.activationId,
        lane: 'chat'
      })
    } catch (error) {
      // The message and its journal row are written together or not at all: the bot never runs unrecorded.
      const code = (error as { code?: unknown } | null)?.code
      if (code !== 'bot_journal_failed' && code !== 'storage_full') throw error
      this.engine.journalFailedFor(input.botId)
      throw new BotEngineError('bot_journal_failed', 'I can\'t save my work. Free some disk space.')
    }
    const prompt = chatInput(text, input.attachments)
    try {
      if (await this.engine.continueChatWith(input.botId, prompt)) return { message }
      this.engine.approveStarterIfNeeded(definition.id)
      await this.engine.enqueueChat(input.botId, `chat:${input.clientRequestId}`, prompt, target.continues ? undefined : target.activationId)
    } catch (error) {
      // The message is kept; the chat says why nothing answered it.
      if (!(error instanceof BotEngineError)) throw error
      this.engine.chatError(input.botId, error.code)
    }
    return { message }
  }

  /** `bots.chat.stop`: the chat lane's activation stops. */
  async chatStop(botId: string): Promise<Record<string, never>> {
    await this.engine.stopChat(botId)
    return {}
  }

  /** `bots.chat.markRead`: the owner has read up to `seq`. */
  markRead(botId: string, seq: number): Record<string, never> {
    this.engine.markRead(botId, seq)
    return {}
  }

  /** `bots.asks.answer` (§5.4). */
  async answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<{ message: BotChatMessage }> {
    this.engine.definitionOf(botId)
    const message = await this.engine.answerAsk(botId, askId, answer)
    if (!message) throw new BotEngineError('ask_not_found', 'No such ask.')
    return { message }
  }

  /** `bots.permissions.revoke`: About → Can use → Remove narrows the grant (no consent needed). */
  revokePermission(botId: string, id: string): BotDetail {
    this.engine.definitionOf(botId)
    const grant = this.store.activeGrant(botId)
    const permission = grant ? grantedPermissions(grant.manifest).find((item) => permissionId(item) === id) : undefined
    if (!permission) throw new BotEngineError('permission_not_found', 'This bot doesn\'t have that permission.')
    this.engine.narrowGrant(botId, (manifest) => withoutPermission(manifest, permission))
    return this.detailOf(botId)
  }

  /** `bots.schedules.remove`: About → Runs → Remove. */
  removeSchedule(botId: string, scheduleId: string): BotDetail {
    if (!this.engine.removeSchedule(botId, scheduleId)) throw new BotEngineError('schedule_not_found', 'This bot has no such schedule.')
    return this.detailOf(botId)
  }

  /** The profile's bot memory, for one of its bots (`bots.memory.*`, through `botMemoryMethods`). */
  memoryFor(botId: string): BotMemoryAdmin {
    this.engine.definitionOf(botId)
    if (!this.options.memory) throw new BotEngineError('bots_unavailable', 'Bot memory is not available in this build.')
    return this.options.memory
  }

  memoryList(botId: string, history?: boolean): BotMemoryListing {
    return this.memoryFor(botId).list(botId, history)
  }

  memoryForget(botId: string, id: string): BotMemoryForgetResult {
    return this.memoryFor(botId).forget(botId, id)
  }

  memoryExport(botId: string, dir: string): Promise<{ files: string[] }> {
    return this.memoryFor(botId).export(botId, dir)
  }
}
