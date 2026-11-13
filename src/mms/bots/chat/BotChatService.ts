import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BotChatMessage, BotChip, BotDetail, BotSummary } from '../../../shared/bots/personal/chat'
import { BOT_MODEL_SLOT_KEYS, DEFAULT_BOT_MODEL, MAX_BOT_DESCRIPTION_CHARS, MAX_BOT_NAME_CHARS, type BotDefinition, type BotModelPick, type BotModelSlotKey, type BotModelSlots, type BotSchedule } from '../../../shared/bots/personal/definition'
import { normalizeBotLook, type BotLook } from '../../../shared/bots/personal/look'
import { isSpecialAsk } from '../../../shared/bots/personal/escalation'
import { BOT_THREADS_PERMISSION, botGrantTool } from '../../../shared/bots/personal/manifest'
import type { BotOwnerTurn } from '../../../shared/bots/personal/definition'
import type { PermissionMode } from '../../../shared/permissionMode'
import type { BotMemoryForgetResult, BotMemoryListing } from '../../../shared/bots/personal/memory'
import { MAX_BOT_CHAT_PAGE, type BotChatAttachment, type BotImageUsage, type BotModelOption, type BotRunsOnChoices, type BotShownRows } from '../../../shared/bots/personal/methods'
import { allPinned, isPinned, shownPick, slotsAllOn, UNPICKED_SLOTS, withImagePick, withSlots } from '../../../shared/bots/personal/modelSlots'
import type { BotImageOption } from '../images/BotImageMaker'
import { botPickProviderOptions, type LlmProviderOption } from '../../../shared/settings'
import { copyBotAttachments, removeBotAttachments, type SavedBotAttachment } from './attachments'
import { BotEngineError, type BotEngine } from '../activation/BotEngine'
import type { BotMemoryAdmin } from '../seams'
import type { BotStore } from '../store/BotStore'
import { grantedPermissions, permissionId, starterManifest, withoutPermission } from './projection'

/**
 * The Bot UI's daemon side (Bot Phase 1 §5.3, §5.11): create a bot from a look and a sentence,
 * chat with it, answer its asks, and manage it from its menu and About. Every result is built from
 * `bots.db` by the projection, so no model or instance id reaches a client, apart from Runs on's (`bots.model.*`, #673).
 */

export type BotAutomationRunStatus = 'queued' | 'running' | 'waiting_grant' | 'paused' | 'blocked' | 'done' | 'failed' | 'cancelled'

/**
 * What the Automations page shows of a bot beside one of its schedules (whose record is an ordinary automation in the
 * shared store): the bot's name and face, its own pause, and the runs that schedule started. No model or instance id.
 */
export interface BotAutomationFacts {
  botName: string
  look: BotLook
  /** The bot itself is paused (by its owner, after three failed runs, or until a usage limit resets). */
  paused: boolean
  pausedText?: string
  /** Newest first. */
  runs: Array<{ id: string; status: BotAutomationRunStatus; at: string; endedAt?: string; endReason?: string; threadId?: string }>
  /** An open ask one of these runs raised; it is answered in the bot chat, or in place from Needs you (`askId`). */
  ask?: { text: string; activationId: string; askId?: string }
}

const MODEL_UNAVAILABLE_TEXT = 'The model you picked is not available now. Pick another one.'

/** Runs on's Images row (#1088): the image models on offer now, and a bot's pictures today. */
export interface BotChatImages {
  options(): Promise<BotImageOption[]>
  usage(botId: string): BotImageUsage
}

/** The Images row's tooltip while no entry of the owner's can make pictures. */
export const IMAGES_MISSING_TEXT = 'Add an OpenRouter entry with an API key in Settings → Providers to pick an image model.'

/**
 * The Images row's choices as the app's model picker takes them: each entry with its image models, named and marked as
 * the app's listing names that entry (its provider for the logo), else by the entry alone.
 */
export function imageProviderOptions(listing: readonly LlmProviderOption[], options: readonly BotImageOption[]): LlmProviderOption[] {
  const byEntry = new Map<string, LlmProviderOption>()
  for (const option of options) {
    const listed = listing.find((provider) => provider.instanceId === option.instanceId)
    const entry = byEntry.get(option.instanceId) ?? {
      id: listed?.id ?? option.instanceId.split(':').at(-1) ?? option.instanceId,
      instanceId: option.instanceId,
      label: listed?.label ?? option.entry,
      models: []
    }
    entry.models.push({ id: option.model, label: option.label })
    byEntry.set(option.instanceId, entry)
  }
  return [...byEntry.values()]
}

/** An Images row pick on an option offered now, with what the entry is signed in with now; never a reasoning level. */
function stampedImagePick(options: readonly BotImageOption[], pick: BotModelPick): BotModelPick & { instanceId: string } {
  const option = options.find((entry) => entry.instanceId === pick.instanceId && entry.model === pick.model)
  if (!option) throw new BotEngineError('model_unavailable', MODEL_UNAVAILABLE_TEXT)
  return { instanceId: option.instanceId, model: option.model, ...(option.credential ? { credential: option.credential } : {}), ...(option.account ? { account: option.account } : {}) }
}

/**
 * A pick on an option offered now, with what the entry is signed in with now (#673): the daemon writes these, never a
 * client, so a pick notices when its entry later signs in another way or to another account.
 */
export function stampedPick(option: BotModelOption, effort?: string): BotModelPick {
  return {
    instanceId: option.instanceId,
    model: option.model,
    ...(effort ? { effort } : {}),
    ...(option.credential ? { credential: option.credential } : {}),
    ...(option.account ? { account: option.account } : {})
  }
}

/** The option a pick names among `options`, at a reasoning level it offers. */
function offeredOption(options: readonly BotModelOption[], pick: BotModelPick): BotModelOption | undefined {
  const option = options.find((entry) => entry.instanceId === pick.instanceId && entry.model === pick.model)
  return option && (pick.effort === undefined || option.efforts.includes(pick.effort)) ? option : undefined
}

/** A model by name (the single picker before rows) on the entry that offers it, ranked as `use_model` ranks. */
function optionByName(model: string, options: readonly BotModelOption[]): BotModelOption | undefined {
  const offering = options.filter((option) => option.model === model)
  return offering.find((option) => option.credential === 'subscription') ?? offering[0]
}

/** A bot's rows as Runs on shows them: a pick on an entry, or null ("Pick a model"); never what the sign-in was. */
function shownRows(slots: BotModelSlots): BotShownRows {
  const shown = (pick: BotModelPick | null) => (isPinned(pick) ? shownPick(pick) : null)
  return { talk: shown(slots.talk), light: shown(slots.light), medium: shown(slots.medium), hard: shown(slots.hard) }
}

/** How long naming a new bot may take before the description names it (§5.3.1). */
export const BOT_NAMING_TIMEOUT_MS = 5_000

/** The line a message from another device gets when that device lost the bot before the message was answered. */
export const NOT_DELIVERED_TEXT = 'Not delivered: the device it came from can no longer reach me.'

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

/** The input of a new bot's first chat activation (§5.3.1, step 6). `nameIt`: its name was made from the description, so it picks its own. */
export function firstMessagePrompt(description: string, nameIt = false): string {
  const naming = nameIt ? ' The owner gave you no name: pick a short one (two or three words) and set it with set_profile before you answer.' : ''
  return `[Mousse] The owner just created you. Their description: "${description}".${naming} In one or two sentences say what you understood and what they can ask you for. Don't ask for permissions now: you already have your files folder, your memory, the web and your own tools, and you ask for anything more only when the owner wants something that needs it. If the description is unclear, ask one question instead.`
}

/** A chat message as the bot's input: the owner's text, and the files attached to it (their copies in the files folder). */
export function chatInput(text: string, attachments: readonly SavedBotAttachment[] | undefined): string {
  if (!attachments?.length) return text
  const files = `Attached files:\n${attachments.map((file) => `- ${file.name}: ${file.path}`).join('\n')}`
  return text ? `${text}\n\n${files}` : files
}

/**
 * An owner's message row as the bot's input, as `chatSend` built it: the reply line when it answers an earlier
 * message of the same chat, its text, and its files. Rebuilt from the rows after a restart, so it must match.
 */
export function messageInput(row: { botId: string; text: string; attachments: readonly SavedBotAttachment[] | null; replyTo: string | null }, quoted: (id: string) => { botId: string; author: 'owner' | 'bot'; text: string } | undefined): string {
  const body = chatInput(row.text, row.attachments ?? undefined)
  const reply = row.replyTo ? quoted(row.replyTo) : undefined
  return reply && reply.botId === row.botId ? `${replyLine(reply)}\n\n${body}` : body
}

/** The longest part of a quoted message the bot is shown with a reply. */
const REPLY_QUOTE_CHARS = 600

/**
 * The line before the owner's message when it replies to an earlier one, so the bot knows what "this" or "done" is
 * about: the bot's own message, or one the owner wrote before.
 */
export function replyLine(quoted: { author: 'owner' | 'bot'; text: string }): string {
  const text = quoted.text.replace(/\s+/g, ' ').trim()
  const cut = text.length > REPLY_QUOTE_CHARS ? `${text.slice(0, REPLY_QUOTE_CHARS - 1)}…` : text
  return quoted.author === 'bot' ? `(Replying to your message: "${cut}")` : `(About their earlier message: "${cut}")`
}

export class BotChatService {
  constructor(private readonly engine: BotEngine, private readonly options: {
    store: BotStore
    memory?: BotMemoryAdmin
    now(): number
    /** The models the owner may pick by hand (#673): each ready entry's models that can hold a bot here (`BotModelChooser.pickable`). */
    modelOptions?(): Promise<BotModelOption[]>
    /** The app's model listing, narrowed to `modelOptions` for the model picker Runs on shows. */
    modelListing?(): Promise<LlmProviderOption[]>
    /** Runs on's line for a bot's row on an entry (`HarnessGateway.botRunsOnNote`): a Codex not checked for bots. */
    runsOnNote?(instanceId: string): { text: string; title: string } | undefined
    /** Runs on's Images row (#1088). Absent: no Images row. */
    images?: BotChatImages
    /** This computer's name, as the rest of the app shows it. */
    computerName?(): string
    /** The person's other computers, online or not. */
    otherComputers?(): Array<{ node: string; name: string; online: boolean }>
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
   * The models (#673, `slots`) are the owner's picks on every row, each offered now: one that is not is refused in plain
   * words, never swapped for another. The bot names itself and says its first message on its Talk pick. An app from
   * before rows sends one `model` by name (on every row), and one from before picks none (by usage).
   */
  async create(input: { look: BotLook; name?: string; description: string; clientRequestId: string; model?: string; slots?: BotModelSlots; image?: BotModelPick }): Promise<{ bot: BotSummary }> {
    const description = input.description.trim()
    if (!description || description.length > MAX_BOT_DESCRIPTION_CHARS) throw new BotEngineError('invalid_params', `Say what the bot should do in 1 to ${MAX_BOT_DESCRIPTION_CHARS} characters.`)
    const given = input.name?.trim()
    if (input.name !== undefined && given && given.length > MAX_BOT_NAME_CHARS) throw new BotEngineError('invalid_params', `A name is at most ${MAX_BOT_NAME_CHARS} characters.`)
    const key = `create:${input.clientRequestId}`
    const made = this.store.activationByKey(key)
    if (made) return { bot: this.summaryOf(made.botId) }
    let slots: BotModelSlots = { ...UNPICKED_SLOTS }
    const picked = input.model?.trim() || undefined
    if (input.slots) {
      if (!BOT_MODEL_SLOT_KEYS.every((row) => isPinned(input.slots![row]))) throw new BotEngineError('invalid_params', 'Pick a model for Talk and for Work.')
      const options = await this.pickableOptions().catch(() => [])
      slots = { ...UNPICKED_SLOTS }
      for (const row of BOT_MODEL_SLOT_KEYS) slots[row] = this.offeredPick(options, input.slots[row]!)
    } else if (picked) {
      const option = optionByName(picked, await this.pickableOptions().catch(() => []))
      if (!option) throw new BotEngineError('model_unavailable', MODEL_UNAVAILABLE_TEXT)
      slots = slotsAllOn(stampedPick(option))
    }
    // The Images row (#1088), when New bot picked one: offered now, or the create is refused like a row's pick.
    let image: BotModelPick | undefined
    if (input.image) {
      if (!this.options.images || !isPinned(input.image)) throw new BotEngineError('model_unavailable', MODEL_UNAVAILABLE_TEXT)
      image = stampedImagePick(await this.options.images.options().catch(() => []), input.image)
    }
    const botId = `bot-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const named = given ? { name: given, chosen: true } : await this.nameFor(botId, description, slots.talk)
    const name = named.name
    const definition: BotDefinition = {
      format: 2,
      id: botId,
      name,
      description,
      look: normalizeBotLook(input.look),
      owner: { kind: 'person', id: 'self' },
      placement: { kind: 'this_computer' },
      role: description,
      // The rows as About's picker saves them (`setOwnerSlots`), at the default depth.
      main: withImagePick(withSlots({ key: 'main', title: 'Main', agent: { instructions: '' }, model: { ...DEFAULT_BOT_MODEL } }, slots), image ?? null),
      context: [],
      permissions: starterManifest(),
      triggers: { manual: true }
    }
    // A duplicate create in flight at the same time found nothing yet: the first one wins.
    const raced = this.store.activationByKey(key)
    if (raced) return { bot: this.summaryOf(raced.botId) }
    this.engine.createBot(definition)
    await this.engine.enqueueChat(botId, key, firstMessagePrompt(description, !named.chosen))
    return { bot: this.summaryOf(botId) }
  }

  /**
   * The bot names itself on its own model (`harness.oneShot`); on a failure or after 5 seconds (a
   * runtime with no single requests) the description names it for now, and
   * the bot picks its own name in its first turn (`chosen: false`).
   */
  private async nameFor(botId: string, description: string, talk: BotModelPick | null): Promise<{ name: string; chosen: boolean }> {
    const answer = await this.engine.oneShotFor(botId, `Two or three words naming a helper that does: ${description}\nAnswer with the name only, in plain title case.`, BOT_NAMING_TIMEOUT_MS, talk)
    const name = answer ? cleanBotName(answer) : undefined
    return name ? { name, chosen: true } : { name: fallbackBotName(description), chosen: false }
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
   * (its asks count as Not now), or the chat activation queued with the message (in the same
   * transaction) starts behind the lane. Sending the same request again answers a wall the first
   * one never reached.
   */
  async chatSend(input: { botId: string; text: string; attachments?: BotChatAttachment[]; clientRequestId: string; replyTo?: string; from?: { limit: PermissionMode; node?: string } }): Promise<{ message: BotChatMessage }> {
    const definition = this.engine.definitionOf(input.botId)
    const text = input.text.trim()
    if (!text && !input.attachments?.length) throw new BotEngineError('invalid_params', 'The message is empty.')
    const existing = this.store.messageByRequest(input.clientRequestId)
    if (existing) {
      if (existing.botId !== input.botId) throw new BotEngineError('client_request_id_conflict', 'This request belongs to another bot.')
      await this.engine.admitWallMessage(existing)
      return { message: this.engine.chat.toMessage(this.store.message(existing.id) ?? existing) }
    }
    // The activation this message belongs to: its row and journal row say so (the chat pack then
    // leaves it out, as it is the request).
    const target = this.engine.chatActivationFor(input.botId)
    // The files are copied into the bot's files folder first: the bot reads its copies, so its grant needs nothing more.
    const saved = input.attachments?.length ? copyBotAttachments(this.engine.filesFolder(input.botId), input.attachments, this.options.now()) : []
    // A reply names a message of this bot's chat; any other id is dropped, never shown or sent.
    const quoted = input.replyTo ? this.store.message(input.replyTo) : undefined
    const replyTo = quoted && quoted.botId === input.botId ? quoted : undefined
    const prompt = messageInput({ botId: input.botId, text, attachments: saved, replyTo: replyTo?.id ?? null }, (id) => this.store.message(id))
    const key = `chat:${input.clientRequestId}`
    // The owner wrote this: the turn it starts or continues may start, message and stop their threads, held to the
    // limit of the device it came from (`BotOwnerTurn`; absent: this computer's own window).
    const owner: BotOwnerTurn = input.from ? { limit: input.from.limit, ...(input.from.node ? { node: input.from.node } : {}) } : {}
    let message: BotChatMessage
    let refused: BotEngineError | undefined
    try {
      message = this.store.db.transaction(() => {
        const posted = this.engine.chat.post({
          botId: input.botId,
          author: 'owner',
          kind: 'text',
          text,
          ...(saved.length ? { attachments: saved } : {}),
          clientRequestId: input.clientRequestId,
          activationId: target.activationId,
          lane: 'chat',
          ...(replyTo ? { replyTo: replyTo.id } : {})
        })
        if (!target.continues) refused = this.engine.queueChatInTx(input.botId, key, prompt, target.activationId, owner)
        // A message from another device that continues a turn waiting at a wall holds the rest of that turn to the
        // device's limit, written with the message: a restart before the turn continues (`admitWallMessage`) keeps it.
        else if (owner.limit) this.store.narrowOwnerLimit(target.activationId, owner.limit)
        return posted
      })
    } catch (error) {
      removeBotAttachments(saved)
      // The message and its journal row are written together or not at all: the bot never runs unrecorded.
      const code = (error as { code?: unknown } | null)?.code
      if (code !== 'bot_journal_failed' && code !== 'storage_full') throw error
      this.engine.journalFailedFor(input.botId)
      throw new BotEngineError('bot_journal_failed', 'I can\'t save my work. Free some disk space.')
    }
    try {
      // A limit answered Not now ends its walled turn first; the queued activation then starts.
      const continued = await this.engine.continueChatWith(input.botId, prompt, owner)
      if (target.continues) {
        if (continued) return { message }
        // The wall was answered meanwhile: the message starts a chat of its own.
        this.engine.approveStarterIfNeeded(definition.id)
        await this.engine.enqueueChat(input.botId, key, prompt, undefined, owner)
      } else if (refused) throw refused
      else await this.engine.startQueuedChat(input.botId, target.activationId)
    } catch (error) {
      // The message is kept; the chat says why nothing answered it.
      if (!(error instanceof BotEngineError)) throw error
      this.engine.chatError(input.botId, error.code)
    }
    return { message }
  }

  /**
   * Messages from another device whose chat turn has not started, from a device that can no longer reach the bot
   * (`lost`, read now): none is delivered. Its turn is cancelled and the chat says so in one line. A turn already running
   * carries on, and so does the bot's work: they are the owner's, not the device's.
   */
  async withdrawQueued(lost: (botId: string, node: string) => boolean): Promise<number> {
    let withdrawn = 0
    for (const botId of this.engine.botIds())
      for (const row of this.store.laneActivations(botId, 'chat', ['queued'])) {
        const node = row.trigger.kind === 'manual' ? row.trigger.owner?.node : undefined
        if (!node || !lost(botId, node)) continue
        await this.engine.stop(row.id)
        if (this.store.activation(row.id)?.status !== 'cancelled') continue
        this.engine.chat.post({ botId, author: 'bot', kind: 'notice', text: NOT_DELIVERED_TEXT, activationId: row.id, lane: 'chat', id: `bm_${row.id}_withdrawn` })
        withdrawn += 1
      }
    return withdrawn
  }

  /** `bots.chat.stop`: the chat lane's activation stops. */
  async chatStop(botId: string): Promise<Record<string, never>> {
    await this.engine.stopChat(botId)
    return {}
  }

  /** `bots.work.stop`: one piece of work (or a scheduled run) of the bot stops; the chat goes on. */
  async workStop(botId: string, workId: string): Promise<{ stopped: boolean }> {
    this.engine.definitionOf(botId)
    const result = await this.engine.stopWork(botId, workId)
    if (result === 'not_found') throw new BotEngineError('work_not_found', 'This bot has no such work.')
    return { stopped: result === 'stopped' }
  }

  /**
   * `bots.reminders.cancel`: a waiting reminder is cancelled through the bot's own cancel path, so it is never said or
   * started. One said meanwhile is left as it is; one this bot never had is an error.
   */
  reminderCancel(botId: string, reminderId: string): BotDetail {
    this.engine.definitionOf(botId)
    if (this.store.reminder(reminderId)?.botId !== botId) throw new BotEngineError('reminder_not_found', 'This bot has no such reminder.')
    this.engine.tools.reminders.cancel(botId, reminderId)
    return this.detailOf(botId)
  }

  /**
   * `bots.chat.react`: the owner's reaction on one of the bot's messages. One per message: a new emoji replaces it,
   * `null` removes it. It never starts a turn: the bot's next chat turn is told (its situation). The row is published
   * again, so every window shows it.
   */
  react(botId: string, messageId: string, emoji: string | null): { message: BotChatMessage } {
    this.engine.definitionOf(botId)
    const row = this.store.message(messageId)
    if (row?.botId !== botId) throw new BotEngineError('message_not_found', 'This bot has no such message.')
    if (row.author !== 'bot') throw new BotEngineError('not_reactable', "Only the bot's messages take a reaction.")
    this.store.setOwnerReaction(messageId, emoji, new Date(this.options.now()).toISOString())
    return { message: this.engine.chat.republish(messageId)! }
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

  /**
   * The checks `answer` makes before it changes anything, without answering: for a caller that must refuse plainly
   * (a phone), and the ask's kind (`export_memory` needs a folder picker on this computer).
   */
  askKind(botId: string, askId: string): 'permission' | 'export_memory' | 'threads' {
    this.engine.definitionOf(botId)
    const escalation = this.store.escalation(askId)
    if (!escalation || escalation.botId !== botId) throw new BotEngineError('ask_not_found', 'No such ask.')
    if (escalation.status !== 'open') throw new BotEngineError('ask_answered', 'This was already answered.')
    if (escalation.mode === 'wall' && this.store.activation(escalation.activationId)?.status === 'running')
      throw new BotEngineError('ask_not_ready', 'Wait until the bot finishes its message.')
    if (isSpecialAsk(escalation.permission)) return 'export_memory'
    // "Use your threads" starts threads that run with full access: another device allows it only if it may run them so.
    return 'tool' in escalation.permission && botGrantTool(escalation.permission.tool) === BOT_THREADS_PERMISSION ? 'threads' : 'permission'
  }

  /**
   * One file a chat message carries, for a device that can't open this computer's files (a phone): only the copy in
   * the bot's own files folder, where every attachment is kept, never a path anywhere else.
   */
  attachmentFile(botId: string, messageId: string, index: number): { name: string; path: string } {
    this.engine.definitionOf(botId)
    const folder = this.engine.filesFolder(botId)
    const row = this.store.message(messageId)
    if (!row || row.botId !== botId) throw new BotEngineError('message_not_found', 'No such message.')
    const file = row.attachments?.[index]
    if (!file) throw new BotEngineError('attachment_not_found', 'No such file.')
    let real: string
    let root: string
    try {
      real = realpathSync(file.path)
      root = realpathSync(folder)
    } catch {
      throw new BotEngineError('attachment_not_found', `${file.name} is no longer on the computer.`)
    }
    if (!real.startsWith(root + sep)) throw new BotEngineError('attachment_not_found', `${file.name} is not in the bot's files.`)
    return { name: file.name, path: real }
  }

  /** `bots.permissions.revoke`: About → Can use → Remove narrows the grant (no consent needed). */
  revokePermission(botId: string, id: string): BotDetail {
    this.engine.definitionOf(botId)
    const grant = this.store.activeGrant(botId)
    const permission = grant ? grantedPermissions(grant.manifest).find((item) => permissionId(item) === id) : undefined
    if (!permission) throw new BotEngineError('permission_not_found', 'This bot doesn\'t have that permission.')
    this.engine.narrowGrant(botId, (manifest) => withoutPermission(manifest, permission))
    // Its messages that wait in the owner's threads go with it: none of them starts after Remove.
    if ('tool' in permission && botGrantTool(permission.tool) === BOT_THREADS_PERMISSION) this.engine.withdrawThreadMessages(botId)
    return this.detailOf(botId)
  }

  /**
   * A bot beside one of its schedules, as the Automations page shows it: its name and face, its own pause, and the runs
   * that schedule started, newest first, with any open ask such a run raised. Undefined for a bot that is gone or
   * deleted (its schedules leave every list with it).
   */
  automationFacts(botId: string, scheduleId: string, runsPerSchedule = 10): BotAutomationFacts | undefined {
    let definition: BotDefinition
    try {
      definition = this.engine.definitionOf(botId)
    } catch {
      return undefined
    }
    const summary = this.engine.chat.summary(definition, this.options.now())
    const runs = this.store.all(
      "SELECT * FROM bot_activations WHERE bot_id = ? AND json_extract(trigger_json, '$.kind') = 'schedule' AND json_extract(trigger_json, '$.scheduleId') = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      botId, scheduleId, runsPerSchedule
    ).map((row) => ({
      id: row.id as string,
      status: row.status as BotAutomationRunStatus,
      at: row.created_at as string,
      ...(typeof row.ended_at === 'string' ? { endedAt: row.ended_at } : {}),
      ...(typeof row.end_reason === 'string' ? { endReason: row.end_reason } : {}),
      ...(typeof row.thread_id === 'string' ? { threadId: row.thread_id } : {})
    }))
    const ask = this.store.openAsks(botId).find((entry) => entry.messageId !== null && runs.some((run) => run.id === entry.activationId))
    return {
      botName: definition.name,
      look: summary.look,
      paused: summary.state === 'paused',
      ...(summary.state === 'paused' ? { pausedText: summary.stateText } : {}),
      runs,
      ...(ask ? { ask: { text: this.engine.chat.card(ask).title, activationId: ask.activationId, askId: ask.id } } : {})
    }
  }

  /**
   * `bots.schedules.add`: the owner gives the bot a schedule from the Automations page. A model picked by hand for it
   * (#673) is saved on the entry that offers it now, as a row's pick is (refused when none does), and like any pick it
   * runs there or not at all; its name is kept beside it for older builds. Without one, its runs take the Work rows.
   */
  async addSchedule(botId: string, when: BotSchedule['when'], prompt: string, model?: string): Promise<BotDetail> {
    this.engine.definitionOf(botId)
    let pick: BotModelPick | undefined
    if (model) {
      const option = optionByName(model, await this.pickableOptions().catch(() => []))
      if (!option) throw new BotEngineError('model_unavailable', MODEL_UNAVAILABLE_TEXT)
      pick = stampedPick(option)
    }
    this.engine.addSchedule(botId, { when, prompt, ...(model && pick ? { model, pick } : {}) }, 'owner')
    return this.detailOf(botId)
  }

  /**
   * `bots.model.get` (#673, by hand): the bot's rows and the computer it runs on, with what the owner may pick. A row is
   * a pick on an entry, or null: "Pick a model" on a bot from before picks, where Mousse chooses until the owner picks
   * (`named` says which model by name it runs, if one). Models are the ready ones that can hold a bot here. Computers
   * are this one and the person's other computers, the same list the Automations page's Computer chip offers; a bot runs
   * on the computer that holds it, so the others are listed but cannot be picked (`unavailable` says why), and an
   * offline one says so.
   */
  async modelGet(botId: string): Promise<{ model: string | null; slots: BotShownRows; named?: Partial<Record<BotModelSlotKey, string>>; image?: BotModelPick | null; images?: BotImageUsage } & BotRunsOnChoices> {
    this.engine.definitionOf(botId)
    const choices = await this.modelChoices()
    // Read after the choices: a change the bot made meanwhile shows.
    const slots = this.engine.ownerSlots(botId)
    const named = Object.fromEntries(BOT_MODEL_SLOT_KEYS.flatMap((row) => {
      const pick = slots[row]
      return pick && !isPinned(pick) ? [[row, pick.model]] : []
    })) as Partial<Record<BotModelSlotKey, string>>
    const { last: _last, ...offered } = choices
    const images = this.options.images ? { image: shownPick(this.engine.imagePick(botId)), images: this.options.images.usage(botId) } : {}
    return { model: slots.talk?.model ?? null, slots: shownRows(slots), ...(Object.keys(named).length ? { named } : {}), ...images, ...offered }
  }

  /**
   * `bots.model.choices`: what `bots.model.get` offers, before a bot exists (New bot's Runs on). `providers` are every
   * entry's models for the rows' picker, `last` the rows of the owner's newest bot with picks (null where one is not
   * offered now), and `models`, one per model name, serve an app from before rows.
   */
  async modelChoices(): Promise<BotRunsOnChoices & { last?: BotShownRows }> {
    const options = await this.pickableOptions().catch(() => [])
    let listing: LlmProviderOption[] = []
    try {
      listing = (await this.options.modelListing?.()) ?? []
    } catch {
      // No listing now: the rows offer nothing to pick until it is back.
    }
    const seen = new Set<string>()
    const models = options.flatMap((option) => {
      if (seen.has(option.model)) return []
      seen.add(option.model)
      return [{ model: option.model, label: `${option.entry} · ${option.label}` }]
    })
    const remembered = this.engine.lastPicks()
    const last = remembered ? shownRows(remembered) : undefined
    const offeredNow = (pick: BotModelPick | null) => (pick && offeredOption(options, pick) ? pick : null)
    const computer = this.options.computerName?.() || 'This computer'
    let others: Array<{ node: string; name: string; online: boolean }> = []
    try {
      others = this.options.otherComputers?.() ?? []
    } catch {
      // The device list cannot be read now: this computer is the one listed.
    }
    // Said once in Runs on for an entry a bot's work won't run on (a Codex not checked for bots), before work is sent.
    const notes: Record<string, { text: string; title: string }> = {}
    for (const instanceId of new Set(options.map((option) => option.instanceId))) {
      try {
        const note = this.options.runsOnNote?.(instanceId)
        if (note) notes[instanceId] = note
      } catch {
        // Nothing to say about it now; the turn is still refused where it starts.
      }
    }
    // The Images row (#1088): each ready entry's image models, or a line on what to add.
    let imageChoices: Pick<BotRunsOnChoices, 'imageProviders' | 'imagesMissing'> = {}
    if (this.options.images) {
      const imageProviders = imageProviderOptions(listing, await this.options.images.options().catch(() => []))
      imageChoices = { imageProviders, ...(imageProviders.length ? {} : { imagesMissing: IMAGES_MISSING_TEXT }) }
    }
    return {
      models,
      providers: botPickProviderOptions(listing, options),
      ...imageChoices,
      ...(Object.keys(notes).length ? { notes } : {}),
      ...(last ? { last: { talk: offeredNow(last.talk), light: offeredNow(last.light), medium: offeredNow(last.medium), hard: offeredNow(last.hard) } } : {}),
      computer: 'this_computer',
      computers: [
        { id: 'this_computer', name: computer },
        ...others.map((other) => ({ id: other.node, name: other.name, ...(other.online ? {} : { offline: true as const }), unavailable: other.online ? 'A bot runs on the computer that holds it.' : `${other.name} is offline.` }))
      ]
    }
  }

  private pickableOptions(): Promise<BotModelOption[]> {
    return this.options.modelOptions?.() ?? Promise.resolve([])
  }

  /** A pick the owner sent, as it is saved: on an option offered now, with what its entry is signed in with now. */
  private offeredPick(options: readonly BotModelOption[], pick: BotModelPick): BotModelPick {
    const option = offeredOption(options, pick)
    if (!option) throw new BotEngineError('model_unavailable', MODEL_UNAVAILABLE_TEXT)
    return stampedPick(option, pick.effort)
  }

  /**
   * `bots.model.set` (the single picker before rows): one model by name on every row, on the entry that offers it now;
   * null leaves a bot from before picks by usage. A bot whose rows are all picks is never set back to by usage.
   */
  async modelSet(botId: string, model: string | null): Promise<{ bot: BotSummary }> {
    this.engine.definitionOf(botId)
    if (!model) {
      if (allPinned(this.engine.ownerSlots(botId))) throw new BotEngineError('invalid_params', 'Pick a model for Talk and for Work.')
      return { bot: this.summaryOf(botId) }
    }
    const option = optionByName(model, await this.pickableOptions().catch(() => []))
    if (!option) throw new BotEngineError('model_unavailable', MODEL_UNAVAILABLE_TEXT)
    this.engine.setOwnerSlots(botId, slotsAllOn(stampedPick(option)))
    return { bot: this.summaryOf(botId) }
  }

  /**
   * `bots.model.setSlots` (#673), from About → Runs on, saved over the rows as they are now, so a change the bot made
   * meanwhile stays. `slots`: the rows the owner picked, each offered now, saved with what its entry is signed in with
   * now (picking the same model again on an entry that changed its sign-in accepts the change). `oneWork` (closing
   * Advanced): Medium work's pick on all work, as it is, even when it can't run now; it keeps what its entry was signed
   * in with when it was picked.
   */
  async modelSlotsSet(botId: string, change: { slots?: Partial<BotModelSlots>; oneWork?: boolean }): Promise<{ bot: BotSummary }> {
    this.engine.definitionOf(botId)
    if (change.oneWork) {
      const medium = this.engine.ownerSlots(botId).medium
      if (!isPinned(medium)) throw new BotEngineError('invalid_params', 'Pick a model for Medium work first.')
      this.engine.setOwnerSlots(botId, { light: { ...medium }, hard: { ...medium } })
      return { bot: this.summaryOf(botId) }
    }
    const options = await this.pickableOptions().catch(() => [])
    const saved: Partial<BotModelSlots> = {}
    for (const row of BOT_MODEL_SLOT_KEYS) {
      const pick = change.slots?.[row]
      if (pick === undefined) continue
      if (!isPinned(pick)) throw new BotEngineError('invalid_params', 'Pick a model for each row.')
      saved[row] = this.offeredPick(options, pick)
    }
    if (!Object.keys(saved).length) throw new BotEngineError('invalid_params', 'Pick a model for a row.')
    this.engine.setOwnerSlots(botId, saved)
    return { bot: this.summaryOf(botId) }
  }

  /**
   * `bots.model.setImage` (#1088), from About → Runs on: the Images row's pick, offered now and saved with its entry's
   * sign-in now, or null, which takes `make_image` away from the bot's next turn.
   */
  async modelImageSet(botId: string, pick: BotModelPick | null): Promise<{ bot: BotSummary }> {
    this.engine.definitionOf(botId)
    if (!this.options.images) throw new BotEngineError('bots_unavailable', 'Pictures are not available in this build.')
    const saved = pick ? stampedImagePick(await this.options.images.options().catch(() => []), pick) : null
    this.engine.setImagePick(botId, saved)
    return { bot: this.summaryOf(botId) }
  }

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
