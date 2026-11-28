import { botActionRefusal } from '../../shared/bots/personal/actionRefusal'
import { useEffect } from 'react'
import { create } from 'zustand'
import type { BotChatMessage, BotChatQuote, BotChip, BotDetail, BotSummary } from '../../shared/bots/personal/chat'
import type { BotLook } from '../../shared/bots/personal/look'
import type { BotMemoryEntry } from '../../shared/bots/personal/memory'
import type { BotModelPick, BotModelSlots } from '../../shared/bots/personal/definition'
import type { NewBotAccess } from '../../shared/bots/personal/deviceAccess'
import { withMark, noMarks, type BotMark, type BotMarksByRef } from '../../shared/bots/personal/marks'
import { DEFAULT_BOT_FILTER, type BotListFilter, type BotStateFilter } from '../lib/botList'
import { attachmentTooLargeText } from '../../shared/bots/personal/attachments'
import { MAX_BOT_CHAT_ATTACHMENT_BYTES, MAX_BOT_CHAT_ATTACHMENTS, type BotChatAttachment, type BotShownRows, type BotsPersonalV2Result } from '../../shared/bots/personal/methods'
import type { BotFaceState } from '../components/bots/face/BotFace'
import type { AttachedFile } from '../components/ChatComposer'
import { attachmentPath, createPersonalBotsClient, errorText, personalBotsEvents, type PersonalBotsClient } from '../services/personalBotsClient'
import { keepEqualById } from '../lib/keepEqual'
import { botRetryOf } from '../components/bots/botRetry'
import { expandComposerQuotes, insertQuoteToken, registerQuote } from '../lib/composerQuotes'
import { expandComposerThreadChips } from '../lib/composerThreadChips'
import { clearBotLiveReplies, noteBotReply, noteBots, noteBotStopAsked, noteThreadMessage, setBotLiveReplySources } from './botLiveReplies'
import { adoptFilePreview } from '../components/bots/fileImageCache'
import { REMOTE_BOT_FILE_BYTES } from '../../shared/bots/personal/remoteFiles'
import { copyRemotePictures, filesToSend, forgetFailedRemoteFiles, holdRemotePreview, isRemoteBot, onRemoteFileCopied, placeRemoteFiles, resetRemoteBotFiles, setRemoteBotLookup, type RemoteFileRead } from './remoteBotFiles'
import type { ChatReference } from '../../shared/chatReferences'
import { threadLink } from '../../shared/threadLink'

/**
 * The owner's bots in the Chats tab (Bot Phase 1 §5.12): the list, each bot's chat as far as it
 * was read, the live chip of a working bot, owner messages on their way, and About's detail.
 * Pushed by `bots.changed`, `bots.message` and `bots.activity`; while the Chats tab is open,
 * `useBotsPolling` lists them again every 30 seconds while the window shows, and as soon as it shows
 * again, in case an event was missed. A list that changed nothing keeps the objects held, so nothing renders again for it.
 */

/** Messages one chat page asks for. */
/** A record without one key. */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/** A record without the given keys. */
function withoutKeys<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
  return keys.reduce((kept, key) => withoutKey(kept, key), record)
}

export interface BotActionRefusal { reason: string; text: string }

export const BOT_CHAT_PAGE = 50
/** How long the face plays "done" after a working bot goes idle with a good outcome. */
export const BOT_HAPPY_MS = 2500
/** A fallback for a missed push: every change to a bot is pushed. */
const POLL_MS = 30_000

export interface BotChatCache {
  messages: BotChatMessage[]
  /** Older messages exist before the first one held. */
  hasMore: boolean
  loadingOlder: boolean
}

/** A `/` command that asks first (`/forget`, `/forget history`, `/reset`). */
export type BotConfirmCommand = 'forget' | 'forget-history' | 'reset'
export type BotDialog = { kind: 'rename' | 'look' | 'delete' | 'fullTrust'; botId: string } | { kind: 'confirm'; botId: string; command: BotConfirmCommand }

/** A line Mousse shows in a bot's chat for the owner alone (a `/` command's result): never sent, never the bot's. */
export interface BotLocalNote { id: string; at: string; text: string; error?: true }

/**
 * What the owner has put into New bot so far. It lives here, not in the dialog, so nothing that
 * closes or remounts the dialog loses it; Create bot clears it once the bot is made.
 */
export interface NewBotDraft {
  /** Picked when the dialog first opens: one the owner's other bots don't wear. */
  look: BotLook | null
  name: string
  description: string
  /** A model picked by hand on the single Runs on picker (#673, an older service); null is by usage, the default. */
  model: string | null
  /**
   * The rows on Runs on (#673, `BotModelRows`), each a pick or null (Pick a model). null until Runs on's choices come:
   * then the owner's last bot's picks that are still offered (`seedNewBotRows`), else every row empty. Create bot waits
   * until every row holds a pick, and sends them only to a service whose choices carry `providers`.
   */
  slots: BotShownRows | null
  /** The Images row (#1088): a model to make pictures with, or null (none, the default). */
  image: BotModelPick | null
  /**
   * The Devices step: the owner's other devices turned on for the new bot, none at first (this computer alone). Sent
   * only to a service that takes it.
   */
  devices: string[]
  /** The step New bot shows, so closing and reopening returns to it. */
  step: NewBotStep
  /** The owner typed or picked something: a click beside the dialog no longer closes it. */
  touched: boolean
}
/** New bot's steps: the look, what it does (name and sentence), where it runs, and (with other devices) which reach it. */
export type NewBotStep = 'look' | 'about' | 'runsOn' | 'devices'
const EMPTY_NEW_BOT: NewBotDraft = { look: null, name: '', description: '', model: null, slots: null, image: null, devices: [], step: 'look', touched: false }

/**
 * The step that can fix a refused create: a model no longer offered is Runs on's, a name or sentence the service
 * refuses is What it does's. Anything else (no answer, a busy service) stays where Create bot was pressed.
 */
export function newBotStepForFailure(cause: unknown, current: NewBotStep): NewBotStep {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : ''
  if (code === 'model_unavailable') return 'runsOn'
  if (code === 'invalid_params' || code === 'bot_invalid') return 'about'
  return current
}

interface BotsState {
  profileId: string | null
  bots: BotSummary[]
  loaded: boolean
  chats: Record<string, BotChatCache>
  /** A chat's first load while it runs, or after it failed (until Retry). Absent once the chat is held. */
  chatLoad: Record<string, 'loading' | 'failed'>
  /** The current step of a working bot. */
  live: Record<string, { activationId: string; chip?: BotChip }>
  /** The live chip of each running activation (the chat's turn and each piece of work), by activation id. */
  activity: Record<string, BotChip>
  /** What each running activation said it is doing now, its latest line before a step, by activation id. */
  statuses: Record<string, string>
  /** Owner messages sent and not yet confirmed, shown as sent. */
  pending: Record<string, BotChatMessage[]>
  details: Record<string, BotDetail>
  /** Until when (epoch ms) a bot's face plays "done". */
  happy: Record<string, number>
  drafts: Record<string, string>
  /** The files in each bot's composer: picked, dropped or pasted. */
  attachments: Record<string, AttachedFile[]>
  /** The thread pills in each bot's composer (Copy reference, pasted): sent as their links, which the bot reads by reference. */
  references: Record<string, ChatReference[]>
  /** The message each bot's composer replies to (Reply on a message), shown above the box until sent or dismissed. */
  replyingTo: Record<string, BotChatQuote>
  /** The service has no `bots.chat.react` (an older one): messages show no reaction bar. */
  reactionsMissing: boolean
  snoozeMissing: boolean
  /** The service has no `bots.questions.answer`: questions show no buttons, and the owner answers with Reply. */
  questionsMissing: boolean
  error: string | null
  /** The bot `error` is about; null when it is about none (a new bot). Only that bot's chat shows it. */
  errorBotId: string | null
  busy: boolean
  newBotOpen: boolean
  newBotDraft: NewBotDraft
  aboutOpen: boolean
  /** About brings this part into view once it opens: Pick a model's rows. */
  aboutFocus: 'runs-on' | null
  dialog: BotDialog | null
  /** Each bot's memory as About and the Memory dialog show it: the entries every turn carries, with their words. */
  memory: Record<string, BotMemoryEntry[]>
  /** Why a bot's memory could not be read. */
  memoryError: Record<string, string>
  /** The Memory dialog: whose, and the words of an entry to show first (a reply's "Saved to memory"). */
  memoryOpen: { botId: string; focus?: string } | null
  /** The service has no `bots.memory.edit` (an older one): entries show no Edit. */
  memoryEditMissing: boolean
  /** Each chat's own lines from `/` commands, oldest first; kept in this window only. */
  notes: Record<string, BotLocalNote[]>
  /** Each bot's slots and the models it can pick, for `/model`'s list and its suggestions (`bots.model.get`). */
  modelInfo: Record<string, BotsPersonalV2Result<'bots.model.get'>>
  /** Adds a line to the bot's chat for the owner alone. */
  addNote(botId: string, text: string, error?: boolean): void
  /** Reads the bot's slots and models again (`modelInfo`); the error's words when they could not be read, else null. */
  loadModelInfo(botId: string): Promise<string | null>
  activate(profileId: string): void
  refresh(): Promise<void>
  loadChat(botId: string): Promise<void>
  loadOlder(botId: string): Promise<void>
  /** Loads older pages until the message is held; false when the chat has no such message. */
  findMessage(botId: string, messageId: string): Promise<boolean>
  markRead(botId: string): void
  /**
   * What this computer marks on the bots it lists, by bot ref (`bot-marks.json` on this computer): pinned, hidden, muted,
   * marked unread. Read once the list shows, and again when any window here changes them.
   */
  marks: BotMarksByRef
  /** The Bots list's filter: kept per profile on this computer, Show hidden for the session only. */
  filter: BotListFilter
  /**
   * The Bots list shows: reads this computer's marks and the saved filter, once a profile. Nothing of it is read at app
   * open or while the sidebar shows threads.
   */
  showList(): void
  loadMarks(): Promise<void>
  /** Sets or clears one mark at once; the service's answer then stands, and a refusal puts the marks back. */
  setMark(botId: string, mark: BotMark, on: boolean): Promise<void>
  setFilter(change: Partial<BotListFilter>): void
  /**
   * "Mark as read" in a bot's menu: clears its marked unread here, and reads its chat to the newest message on the bot's
   * computer, even when its chat was never opened here. Nothing is sent while that computer is offline.
   */
  readAll(botId: string): Promise<void>
  /**
   * This window shows (or stops showing) the chat of a bot of another computer: its chat streams here while it does
   * (`bots.focus`). Said again when the window's service connection opens again, which let go of it.
   */
  focusRemote(botId: string, focused: boolean): void
  setDraft(botId: string, text: string): void
  setAttachments(botId: string, attachments: AttachedFile[]): void
  addReference(botId: string, reference: ChatReference): void
  removeReference(botId: string, referenceId: string): void
  /** Reply to a message (null: not any more). */
  setReplyingTo(botId: string, quote: BotChatQuote | null): void
  send(botId: string): Promise<void>
  /**
   * Retry on the bot's failed message `messageId`: the owner's words and files of the turn that failed are sent again
   * (`botRetryOf`), once however often it is pressed. Nothing when that message offers no Retry.
   */
  retry(botId: string, messageId: string): Promise<void>
  stop(botId: string): Promise<void>
  /** Stops one piece of work (the line above the composer); the chat goes on. */
  stopWork(botId: string, workId: string): Promise<void>
  answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<void>
  snoozeReminder(botId: string, messageId: string, choice: import('../../shared/bots/personal/chat').BotSnoozeChoice): Promise<boolean>
  /**
   * The owner taps one of a question's answers: it is their reply to the question, which the bot answers. False when it
   * was not sent (the error says why, or the service has no buttons for questions).
   */
  answerAction(botId: string, actionId: string, digest: string, answer: 'send' | 'not_now'): Promise<BotActionRefusal | null>
  /** The owner's Continue or Stop on what the bot holds for them (`BotSummary.chainHold`). Rejects with why it did nothing. */
  answerChainHold(botId: string, holdId: string, answer: 'continue' | 'stop'): Promise<void>
  answerQuestion(botId: string, questionId: string, choice: string): Promise<boolean>
  /**
   * The owner's reaction on one of the bot's messages: shown at once, and put back as it was when the service refuses
   * it. `null` removes it. It never starts a turn.
   */
  react(botId: string, messageId: string, emoji: string | null): Promise<void>
  exportMemory(botId: string, askId: string): Promise<void>
  openNewBot(): void
  /** Closes New bot; what was put in stays for the next time it opens. */
  closeNewBot(): void
  setNewBotDraft(change: Partial<Omit<NewBotDraft, 'touched' | 'step'>>): void
  /**
   * New bot's rows once Runs on's choices come: the draft's rows, else `last` (the owner's last bot's picks), each kept
   * only while `offered` (a pick no longer offered is empty again). Seeding is not putting anything in.
   */
  seedNewBotRows(last: BotShownRows | undefined, offered: (pick: BotModelPick) => boolean): void
  /** Moves New bot to a step; moving alone is not putting anything in. */
  setNewBotStep(step: NewBotStep): void
  /** One create at a time: a second call while one is on its way gets the same answer. */
  create(input: { look: BotLook; name?: string; description: string; model?: string; slots?: BotModelSlots; image?: BotModelPick; access?: NewBotAccess }): Promise<BotSummary | null>
  update(botId: string, change: { name?: string; look?: BotLook }): Promise<boolean>
  /**
   * The owner edits the bot's prompt in About (its description; null: back to the default). Its next turn works under
   * it. Why it failed, in words, or null; the failure stays with the editor, not the chat.
   */
  setPrompt(botId: string, description: string | null): Promise<string | null>
  pause(botId: string): Promise<void>
  resume(botId: string): Promise<void>
  /** Make private: only this computer reaches the bot from now on (About's Devices, in one click). */
  makePrivate(botId: string): Promise<void>
  remove(botId: string): Promise<boolean>
  loadDetail(botId: string): Promise<void>
  setPermission(botId: string, permissionId: string, enabled: boolean): Promise<void>
  revokePermission(botId: string, permissionId: string): Promise<void>
  removeSchedule(botId: string, scheduleId: string): Promise<void>
  cancelReminder(botId: string, reminderId: string): Promise<void>
  loadMemory(botId: string): Promise<void>
  openMemory(botId: string, focus?: string): void
  closeMemory(): void
  /** Forgets one entry; the error's words when it was not forgotten, else null. */
  forgetMemory(botId: string, id: string): Promise<string | null>
  /** New words for an entry (`ref`, the version shown); the error's words when they were not saved, else null. */
  editMemory(botId: string, ref: string, text: string): Promise<string | null>
  /** "Ask the bot about this": the entry goes into the composer as a quote, not sent, and the dialog closes. */
  askAboutMemory(botId: string, text: string): void
}

let client: PersonalBotsClient | null = null
/** The client the store talks through; tests pass a fake. */
export function setBotsClient(next: PersonalBotsClient | null): void { client = next }
function bots(): PersonalBotsClient {
  return client ?? (client = createPersonalBotsClient(window.mousse.platformRequest))
}
/** The client the bot screens talk through (About's model and computer). */
export function botsClient(): PersonalBotsClient {
  return bots()
}

let epoch = 0
let refreshOperation: Promise<void> | undefined
/** A refresh was asked for while a list was on its way: that list may predate the change, so one more follows it. */
let refreshAgain = false
let unsubscribe: Array<() => void> = []
/** Each bot's last send whose words came back after a failure: sending the same words again reuses its request id. */
const failedSends = new Map<string, { text: string; clientRequestId: string }>()
/** Each failed message's Retry, by its id: the request id it sends with, so a second press is the same send. */
const retrySends = new Map<string, string>()
/** The id of the bubble shown while the message sent with `clientRequestId` is on its way. */
const pendingId = (clientRequestId: string) => `pending:${clientRequestId}`
/** Composer pictures already handed over (or revoked) while their message was being sent; `send` settles the rest. */
const handedOver = new Set<string>()

/**
 * The composer's pictures of a message being sent, handed to its confirmed copy's files, so a pasted image stays in
 * place from sending to sent instead of waiting empty for the file to be read. A picture with no matching file goes.
 */
function handOverPreviews(botId: string, pending: readonly BotChatMessage[], incoming: readonly BotChatMessage[]): void {
  for (const message of incoming) {
    if (message.author !== 'owner' || !message.clientRequestId) continue
    const sent = pending.find((entry) => entry.id === pendingId(message.clientRequestId!))
    sent?.attachments?.forEach((file, index) => {
      if (!file.previewUrl || handedOver.has(file.previewUrl)) return
      handedOver.add(file.previewUrl)
      const copy = message.attachments?.[index]
      // A file sent to a bot of another computer shows at its place there until its copy here is read.
      if (copy?.path && copy.name === file.name) adoptFilePreview(copy.path, file.previewUrl)
      else if (copy?.remote && copy.name === file.name) holdRemotePreview(botId, copy.remote, file.previewUrl)
      else URL.revokeObjectURL(file.previewUrl)
    })
  }
}
/** Each bot's page of older messages on its way. */
const olderLoads = new Map<string, Promise<void>>()
let pendingCreate: { key: string; clientRequestId: string } | undefined
let createOperation: Promise<BotSummary | null> | undefined
/** Bots made here that no list has carried yet. */
const created = new Set<string>()
const readSeq = new Map<string, number>()
/** The bots of other computers whose chats this window shows, by how many views show each (`focusRemote`). */
const focusedRemote = new Map<string, number>()
/** Bots deleted in this profile: a list that was on its way when one was deleted never brings it back. */
const removed = new Set<string>()
/**
 * Each message's reactions on their way (`botId:messageId`): the reaction the service last confirmed, and the newest
 * pick's number. A refused pick puts back the confirmed one, never another pick's, and only the newest pick is shown.
 */
const reactions = new Map<string, { confirmed: string | undefined; latest: number }>()
let reactionPicks = 0
/** The service does not know the method (an older one), by its code or, over IPC, its message. */
const missingMethod = (cause: unknown) => ['method_not_available', 'method_not_found', 'unknown_method', 'platform_method_not_allowed'].includes(String((cause as { code?: unknown } | null)?.code ?? ''))
  || /method[ _]not[ _](?:allowed|found|available)|unknown[ _]method|domain method is unavailable|not allowlisted/i.test(cause instanceof Error ? cause.message : String(cause))
/**
 * The bots of the owner's other computers (`bots.remote.list`). None from a service without them (no Bridge, or older);
 * undefined when they could not be read now, so the ones listed before stay.
 */
async function remoteList(): Promise<BotSummary[] | undefined> {
  try {
    return (await bots().remoteList()).filter((bot) => bot.lives)
  } catch (cause) {
    return missingMethod(cause) ? [] : undefined
  }
}

const filterKey = (profileId: string) => `mousse-profile-${profileId}-bots-filter`
const STATE_FILTERS: readonly BotStateFilter[] = ['all', 'needs', 'working']

/** The profile's saved Bots filter on this computer; Show hidden is never saved. */
function savedFilter(profileId: string): BotListFilter {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(filterKey(profileId)) ?? 'null') as Partial<Record<keyof BotListFilter, unknown>> | null
    return {
      computer: typeof saved?.computer === 'string' && saved.computer ? saved.computer : 'all',
      state: STATE_FILTERS.includes(saved?.state as BotStateFilter) ? saved!.state as BotStateFilter : 'all',
      hideOffline: saved?.hideOffline === true,
      showHidden: false
    }
  } catch {
    return DEFAULT_BOT_FILTER
  }
}

function saveFilter(profileId: string | null, filter: BotListFilter): void {
  if (!profileId) return
  const { showHidden: _session, ...kept } = filter
  try { globalThis.localStorage?.setItem(filterKey(profileId), JSON.stringify(kept)) } catch { /* kept for this session */ }
}

/**
 * Marks changes sent and not answered yet, and the newest one's number: only the answer to the newest change stands,
 * and a list read while one is on its way is not shown over it.
 */
let marksInFlight = 0
/** The Bots list showed in this profile: its marks and saved filter were read then (`showList`), never at app open. */
let listShown = false
let marksLatest = 0

const happyTimers = new Map<string, ReturnType<typeof setTimeout>>()

const bySeq = (a: BotChatMessage, b: BotChatMessage) => a.seq - b.seq
/** Reads the copy here of a file of a bot of another computer. */
const readRemoteFile: RemoteFileRead = (botId, ref) => bots().remoteFile(botId, ref)
/**
 * `botId`'s `messages` with `incoming` added or replaced by id, in seq order. A bot of another computer's files are
 * placed (`remoteBotFiles.ts`), and its pictures without a copy here are read.
 */
function upsert(botId: string, messages: BotChatMessage[], incoming: BotChatMessage[]): BotChatMessage[] {
  const placed = placeRemoteFiles(botId, incoming)
  copyRemotePictures(botId, placed, readRemoteFile)
  const byId = new Map(messages.map((message) => [message.id, message]))
  for (const message of placed) byId.set(message.id, message)
  return [...byId.values()].sort(bySeq)
}
const replaceBot = (list: BotSummary[], bot: BotSummary) =>
  removed.has(bot.id) ? list : list.some((entry) => entry.id === bot.id) ? list.map((entry) => (entry.id === bot.id ? bot : entry)) : [...list, bot]

/** A composer file as `bots.chat.send` names it: its name and its path on this computer. */
async function attachmentOf(attached: AttachedFile): Promise<BotChatAttachment> {
  return { name: attached.file.name || 'file', path: await attachmentPath(attached.file) }
}

/** Why these files can't be sent, or null when they can. A bot of another computer (`remote`) takes smaller files. */
function attachmentsRefusal(files: readonly AttachedFile[], remote: boolean): string | null {
  if (files.length > MAX_BOT_CHAT_ATTACHMENTS) return `Attach at most ${MAX_BOT_CHAT_ATTACHMENTS} files.`
  const limit = remote ? REMOTE_BOT_FILE_BYTES : MAX_BOT_CHAT_ATTACHMENT_BYTES
  const large = files.find((attached) => attached.file.size > limit)
  return large ? attachmentTooLargeText(large.file.name, limit) : null
}

/** The face a bot shows now: its state, or "done" for a moment after it finished well. */
export function botFaceState(bot: BotSummary, happyUntil: number | undefined, now = Date.now()): BotFaceState {
  return bot.state === 'idle' && happyUntil !== undefined && happyUntil > now ? 'happy' : bot.state
}

/** Bots whose detail a chat card shows (an automation's state): read again on each change, as About's is. */
const detailWatchers = new Map<string, number>()

/** Keeps `botId`'s detail fresh while a card shows it; loads it when it isn't yet. Returns the stop. */
export function watchBotDetail(botId: string): () => void {
  detailWatchers.set(botId, (detailWatchers.get(botId) ?? 0) + 1)
  if (!useBotsStore.getState().details[botId]) void useBotsStore.getState().loadDetail(botId)
  return () => {
    const left = (detailWatchers.get(botId) ?? 1) - 1
    if (left > 0) detailWatchers.set(botId, left)
    else detailWatchers.delete(botId)
  }
}

export const useBotsStore = create<BotsState>((set, get) => {
  const fail = (owner: number, cause: unknown, botId: string | null = null) => { if (owner === epoch) set({ error: errorText(cause), errorBotId: botId, busy: false }) }
  const cacheOf = (botId: string): BotChatCache => get().chats[botId] ?? { messages: [], hasMore: false, loadingOlder: false }
  const putMessages = (botId: string, incoming: BotChatMessage[]) => {
    const placed = placeRemoteFiles(botId, incoming)
    if (!removed.has(botId)) handOverPreviews(botId, get().pending[botId] ?? [], placed)
    putConfirmed(botId, placed)
  }
  setRemoteBotLookup((botId) => Boolean(get().bots.find((bot) => bot.id === botId)?.lives))
  // A file of a bot of another computer was copied here: its chat shows it.
  onRemoteFileCopied((botId) => set((state) => {
    const cache = state.chats[botId]
    const messages = cache ? placeRemoteFiles(botId, cache.messages) : undefined
    return cache && messages !== cache.messages ? { chats: { ...state.chats, [botId]: { ...cache, messages: messages! } } } : {}
  }))
  const putConfirmed = (botId: string, incoming: BotChatMessage[]) => set((state) => {
    if (removed.has(botId)) return {}
    const cache = state.chats[botId] ?? { messages: [], hasMore: false, loadingOlder: false }
    // A confirmed message clears only the bubble sent with its request id, so two identical messages on their way stay two.
    const owned = new Set(incoming.flatMap((message) => (message.author === 'owner' && message.clientRequestId ? [pendingId(message.clientRequestId)] : [])))
    const pending = (state.pending[botId] ?? []).filter((message) => !owned.has(message.id))
    return { chats: { ...state.chats, [botId]: { ...cache, messages: upsert(botId, cache.messages, incoming) } }, pending: { ...state.pending, [botId]: pending } }
  })
  /** A list with the bots made here that no list carried yet: one asked for before a bot was made doesn't drop it. */
  const withCreated = (listed: BotSummary[]): BotSummary[] => {
    for (const bot of listed) created.delete(bot.id)
    return created.size ? [...listed, ...get().bots.filter((bot) => created.has(bot.id))] : listed
  }
  const putBot = (bot: BotSummary) => set((state) => ({ bots: replaceBot(state.bots, bot), ...celebrate(state.bots, [bot]) }))
  /** "Done": a bot that was working and is now idle after a good run plays happy for a moment. */
  const celebrate = (before: BotSummary[], after: BotSummary[]): Pick<BotsState, 'happy'> | Record<string, never> => {
    const happy = { ...get().happy }
    let changed = false
    for (const bot of after) {
      const previous = before.find((entry) => entry.id === bot.id)
      if (previous?.state !== 'working' || bot.state !== 'idle' || bot.lastOutcome !== 'ok') continue
      happy[bot.id] = Date.now() + BOT_HAPPY_MS
      changed = true
      clearTimeout(happyTimers.get(bot.id))
      happyTimers.set(bot.id, setTimeout(() => {
        happyTimers.delete(bot.id)
        set((state) => { const { [bot.id]: _done, ...rest } = state.happy; return { happy: rest } })
      }, BOT_HAPPY_MS))
    }
    return changed ? { happy } : {}
  }
  const subscribe = () => {
    for (const stop of unsubscribe) stop()
    const events = personalBotsEvents()
    // The bot's home thread streams its chat turn's reply: shown as it is written (botLiveReplies.ts).
    const orchestrator = (window.mousse as Partial<typeof window.mousse> | undefined)?.orchestrator
    unsubscribe = [
      orchestrator?.onThreadMessage?.(({ threadId, message }) => noteThreadMessage(threadId, message, true)),
      orchestrator?.onThreadMessageUpdated?.(({ threadId, message }) => noteThreadMessage(threadId, message, false)),
      events.onChanged?.((event) => {
        // Only this computer's marks changed (from this window or another here): the list itself did not.
        if (event?.marks) {
          if (listShown) void get().loadMarks()
          return
        }
        void get().refresh()
        // About, and a chat card that shows one of the bot's automations (`watchBotDetail`), read its runs again.
        if (event?.botId && (get().aboutOpen || detailWatchers.has(event.botId)) && get().details[event.botId]) void get().loadDetail(event.botId)
        // The window's service connection was opened again: a chat it holds reads its newest rows, which also fills
        // any it missed (#1042). With a bot named, only that bot's chat stream opened again (a bot of another computer).
        if (event?.reread) for (const botId of event.botId ? [event.botId] : Object.keys(get().chats)) if (get().chats[botId]) void get().loadChat(botId)
        // A connection opened again let go of the other computers' chats this window showed: it holds them again.
        if (event?.reread && !event.botId) for (const botId of focusedRemote.keys()) void bots().focus(botId, true).catch(() => undefined)
      }),
      events.onReply?.((event) => noteBotReply(event)),
      events.onMessage?.((event) => { if (event?.botId && event.message) putMessages(event.botId, [event.message]) }),
      events.onActivity?.((event) => {
        if (!event?.botId) return
        set((state) => ({
          live: { ...state.live, [event.botId]: { activationId: event.activationId, ...(event.chip ? { chip: event.chip } : {}) } },
          activity: event.chip ? { ...state.activity, [event.activationId]: event.chip } : withoutKey(state.activity, event.activationId),
          // Each event carries the status as it is now: one without it clears it.
          statuses: event.status ? (state.statuses[event.activationId] === event.status ? state.statuses : { ...state.statuses, [event.activationId]: event.status }) : withoutKey(state.statuses, event.activationId)
        }))
      })
    ].filter((stop): stop is () => void => typeof stop === 'function')
  }

  return {
    profileId: null, bots: [], loaded: false, chats: {}, chatLoad: {}, live: {}, activity: {}, statuses: {}, pending: {}, details: {}, happy: {}, drafts: {}, attachments: {}, references: {}, replyingTo: {},
    reactionsMissing: false, snoozeMissing: false, questionsMissing: false, error: null, errorBotId: null, busy: false, newBotOpen: false, newBotDraft: EMPTY_NEW_BOT, aboutOpen: false, aboutFocus: null, dialog: null,
    memory: {}, memoryError: {}, memoryOpen: null, memoryEditMissing: false, notes: {}, modelInfo: {}, marks: {}, filter: DEFAULT_BOT_FILTER,

    activate(profileId) {
      if (get().profileId === profileId) return
      epoch += 1
      refreshOperation = undefined
      refreshAgain = false
      failedSends.clear()
      olderLoads.clear()
      pendingCreate = undefined
      createOperation = undefined
      created.clear()
      readSeq.clear()
      focusedRemote.clear()
      removed.clear()
      reactions.clear()
      resetRemoteBotFiles()
      clearBotLiveReplies()
      set({ profileId, bots: [], loaded: false, chats: {}, chatLoad: {}, live: {}, activity: {}, statuses: {}, pending: {}, details: {}, happy: {}, drafts: {}, attachments: {}, references: {}, replyingTo: {},
        reactionsMissing: false, snoozeMissing: false, questionsMissing: false, error: null, errorBotId: null, busy: false, newBotOpen: false, newBotDraft: EMPTY_NEW_BOT, aboutOpen: false, aboutFocus: null, dialog: null,
    memory: {}, memoryError: {}, memoryOpen: null, memoryEditMissing: false, notes: {}, modelInfo: {}, marks: {}, filter: DEFAULT_BOT_FILTER })
      marksInFlight = 0
      listShown = false
      subscribe()
      void get().refresh()
    },

    showList() {
      const { profileId } = get()
      if (listShown || !profileId) return
      listShown = true
      set({ filter: savedFilter(profileId) })
      void get().loadMarks()
    },

    async loadMarks() {
      const owner = epoch
      const asked = marksLatest
      try {
        const marks = await bots().marks()
        // A change made here since, or still on its way, is not undone by what was read before it.
        if (owner !== epoch || asked !== marksLatest || marksInFlight) return
        set({ marks })
      } catch {
        // An older service keeps no marks; a missed read is read again on the next change.
      }
    },

    async setMark(botId, mark, on) {
      const owner = epoch
      const id = ++marksLatest
      const before = get().marks
      const next = withMark(before[botId], mark, on, new Date().toISOString())
      set({ marks: noMarks(next) ? withoutKey(before, botId) : { ...before, [botId]: next } })
      marksInFlight += 1
      try {
        const marks = await bots().setMark(botId, mark, on)
        if (owner === epoch && id === marksLatest) set({ marks })
      } catch (cause) {
        // An older service keeps no marks: they last this session. Any other refusal puts them back as they were.
        if (owner === epoch && id === marksLatest && !missingMethod(cause)) set({ marks: before, error: errorText(cause), errorBotId: null })
      } finally {
        if (owner === epoch) marksInFlight = Math.max(0, marksInFlight - 1)
      }
    },

    setFilter(change) {
      const filter = { ...get().filter, ...change }
      set({ filter })
      saveFilter(get().profileId, filter)
    },

    async readAll(botId) {
      if (get().marks[botId]?.unread) void get().setMark(botId, 'unread', false)
      const bot = get().bots.find((entry) => entry.id === botId)
      // Read state lives with the bot: nothing is sent to a computer that is offline.
      if (!bot?.unread || bot.lives?.offline) return
      const owner = epoch
      try {
        // Another computer's bot whose chat no view holds open gets no new messages here, so the copy kept of its chat
        // can be behind: its own computer is asked for its newest message, which is what gets marked read.
        const stale = Boolean(bot.lives) && !focusedRemote.has(botId)
        const cached = stale ? undefined : cacheOf(botId).messages.at(-1)?.seq
        const seq = cached ?? (await bots().messages(botId, { limit: 1 })).messages.at(-1)?.seq
        if (seq === undefined || owner !== epoch) return
        readSeq.set(botId, Math.max(readSeq.get(botId) ?? 0, seq))
        set((state) => ({ bots: state.bots.map((entry) => (entry.id === botId && entry.unread ? { ...entry, unread: 0 } : entry)) }))
        await bots().markRead(botId, seq)
      } catch (cause) {
        readSeq.delete(botId)
        if (owner === epoch) set({ error: errorText(cause), errorBotId: null })
      }
    },

    async refresh() {
      // A change pushed while a list is on its way (a thread the bot just started, its status) may be missing from that
      // list, which the service read before the change: the list is read once more after it, never dropped.
      if (refreshOperation) {
        refreshAgain = true
        return refreshOperation
      }
      const owner = epoch
      const operation = (async () => {
        do {
          refreshAgain = false
          try {
            const [local, remote] = await Promise.all([bots().list(), remoteList()])
            if (owner !== epoch) return
            // The other computers' bots join the list; when they can't be read now, the ones listed before stay.
            const elsewhere = remote ?? get().bots.filter((bot) => bot.lives)
            const list = withCreated([...local, ...elsewhere].filter((bot) => !removed.has(bot.id)))
            // A chat held from a computer that was offline reads its newest rows once that computer is back.
            const back = elsewhere.filter((bot) => !bot.lives?.offline && get().bots.some((before) => before.id === bot.id && before.lives?.offline) && get().chats[bot.id])
            // A bot of another computer that left the list read now (this device lost access to it) takes its copy here
            // with it: messages, draft, notes and read mark.
            const gone = remote ? get().bots.filter((bot) => bot.lives && !list.some((kept) => kept.id === bot.id)).map((bot) => bot.id) : []
            for (const botId of gone) readSeq.delete(botId)
            set((state) => {
              // A list that brought nothing new keeps the bots held, so the open chat does not render again.
              const bots = keepEqualById(state.bots, list)
              // Its marks go with it (the service drops its own copy of them too).
              const dropped = gone.length ? {
                chats: withoutKeys(state.chats, gone), chatLoad: withoutKeys(state.chatLoad, gone), drafts: withoutKeys(state.drafts, gone),
                notes: withoutKeys(state.notes, gone), replyingTo: withoutKeys(state.replyingTo, gone), marks: withoutKeys(state.marks, gone)
              } : {}
              // A live chip lasts while its bot works.
              const working = Object.entries(state.live).filter(([id]) => list.some((bot) => bot.id === id && bot.state === 'working'))
              const live = working.length === Object.keys(state.live).length ? state.live : Object.fromEntries(working)
              // A chip lasts while its activation (a chat turn or a piece of work) runs.
              const running = new Set(list.flatMap((bot) => [...(bot.chat ? [bot.chat.activationId] : []), ...(bot.work ?? []).map((item) => item.id)]))
              const kept = Object.entries(state.activity).filter(([id]) => running.has(id))
              const activity = kept.length === Object.keys(state.activity).length ? state.activity : Object.fromEntries(kept)
              const said = Object.entries(state.statuses).filter(([id]) => running.has(id))
              const statuses = said.length === Object.keys(state.statuses).length ? state.statuses : Object.fromEntries(said)
              return { bots, loaded: true, live, activity, statuses, ...dropped, ...celebrate(state.bots, bots) }
            })
            for (const bot of back) void get().loadChat(bot.id)
          } catch {
            // A missed list is listed again by the next event or poll; the open chat keeps what it has.
            if (owner === epoch) set({ loaded: true })
          }
        } while (refreshAgain && owner === epoch)
      })()
      refreshOperation = operation
      try { await operation } finally { if (refreshOperation === operation) refreshOperation = undefined }
    },

    async loadChat(botId) {
      const owner = epoch
      // A chat with nothing held yet says it is loading, and that it failed with Retry; one already shown just updates.
      const first = !get().chats[botId]
      if (first) set((state) => ({ chatLoad: { ...state.chatLoad, [botId]: 'loading' } }))
      // Pictures of a bot of another computer that could not be read are tried again as its chat is read again.
      forgetFailedRemoteFiles(botId)
      try {
        const page = await bots().messages(botId, { limit: BOT_CHAT_PAGE })
        if (owner !== epoch) return
        set((state) => {
          if (removed.has(botId)) return {}
          const chatLoad = withoutKey(state.chatLoad, botId)
          // A full page that does not reach what is held leaves a gap (rows were missed): it starts the chat over.
          const first = Math.min(...page.messages.map((message) => message.seq))
          const gap = page.messages.length >= BOT_CHAT_PAGE && !(state.chats[botId]?.messages ?? []).some((message) => message.seq === first)
          const held = (state.chats[botId]?.messages ?? []).filter((message) => !gap || message.seq > first)
          const { [botId]: _old, ...live } = state.live
          return {
            chats: { ...state.chats, [botId]: { messages: upsert(botId, held, page.messages), hasMore: page.messages.length >= BOT_CHAT_PAGE, loadingOlder: false } },
            live: page.live ? { ...live, [botId]: page.live } : live,
            ...(page.live?.status ? { statuses: { ...state.statuses, [page.live.activationId]: page.live.status } } : {}),
            chatLoad
          }
        })
      } catch (cause) {
        if (owner !== epoch) return
        if (get().chats[botId]) fail(owner, cause, botId)
        else set((state) => ({ chatLoad: { ...state.chatLoad, [botId]: 'failed' } }))
      }
    },

    loadOlder(botId) {
      const cache = cacheOf(botId)
      // A page already on its way is the one asked for again: whoever waits on it waits for that page.
      const loading = olderLoads.get(botId)
      if (loading) return loading
      if (!cache.hasMore || cache.loadingOlder || !cache.messages.length) return Promise.resolve()
      const owner = epoch
      set((state) => ({ chats: { ...state.chats, [botId]: { ...cache, loadingOlder: true } } }))
      const operation: Promise<void> = (async () => {
        try {
          const page = await bots().messages(botId, { beforeSeq: cache.messages[0]!.seq, limit: BOT_CHAT_PAGE })
          if (owner !== epoch) return
          set((state) => {
            const current = state.chats[botId] ?? cache
            return { chats: { ...state.chats, [botId]: { messages: upsert(botId, current.messages, page.messages), hasMore: page.messages.length >= BOT_CHAT_PAGE, loadingOlder: false } } }
          })
        } catch (cause) {
          if (owner === epoch) set((state) => ({ error: errorText(cause), errorBotId: botId, chats: { ...state.chats, [botId]: { ...cacheOf(botId), loadingOlder: false } } }))
        } finally {
          if (owner === epoch) olderLoads.delete(botId)
        }
      })()
      olderLoads.set(botId, operation)
      return operation
    },

    async findMessage(botId, messageId) {
      for (;;) {
        const before = cacheOf(botId)
        if (before.messages.some((message) => message.id === messageId)) return true
        if (!before.hasMore || !before.messages.length) return false
        await get().loadOlder(botId)
        // A page that brought nothing older (it failed, or the profile changed) ends the search.
        const after = cacheOf(botId)
        if (!after.messages.length || after.messages[0]!.seq >= before.messages[0]!.seq) return after.messages.some((message) => message.id === messageId)
      }
    },

    markRead(botId) {
      const last = cacheOf(botId).messages.at(-1)
      if (!last || (readSeq.get(botId) ?? 0) >= last.seq) return
      // Read state lives with the bot: a computer that is offline is told once it is back and its chat is read again.
      if (get().bots.find((bot) => bot.id === botId)?.lives?.offline) return
      readSeq.set(botId, last.seq)
      set((state) => ({ bots: state.bots.map((bot) => (bot.id === botId && bot.unread ? { ...bot, unread: 0 } : bot)) }))
      void bots().markRead(botId, last.seq).catch(() => readSeq.delete(botId))
    },

    focusRemote(botId, focused) {
      const count = (focusedRemote.get(botId) ?? 0) + (focused ? 1 : -1)
      if (count > 0) focusedRemote.set(botId, count)
      else focusedRemote.delete(botId)
      // Only the first view to show it and the last to leave it tell the service.
      if (focused ? count === 1 : count <= 0) void bots().focus(botId, focused).catch(() => undefined)
    },

    addNote(botId, text, error) {
      const note: BotLocalNote = { id: `note:${crypto.randomUUID()}`, at: new Date().toISOString(), text, ...(error ? { error: true as const } : {}) }
      set((state) => ({ notes: { ...state.notes, [botId]: [...(state.notes[botId] ?? []), note] } }))
    },

    async loadModelInfo(botId) {
      const owner = epoch
      try {
        const info = await bots().model(botId)
        if (owner === epoch) set((state) => ({ modelInfo: { ...state.modelInfo, [botId]: info } }))
        return null
      } catch (cause) {
        return errorText(cause)
      }
    },

    setDraft(botId, text) { set((state) => ({ drafts: { ...state.drafts, [botId]: text } })) },
    setAttachments(botId, attachments) { set((state) => ({ attachments: { ...state.attachments, [botId]: attachments } })) },
    addReference(botId, reference) {
      set((state) => {
        const current = state.references[botId] ?? []
        if (current.some((entry) => entry.id === reference.id)) return {}
        return { references: { ...state.references, [botId]: [...current, reference] } }
      })
    },
    removeReference(botId, referenceId) {
      set((state) => ({ references: { ...state.references, [botId]: (state.references[botId] ?? []).filter((entry) => entry.id !== referenceId) } }))
    },
    setReplyingTo(botId, quote) {
      set((state) => {
        const replyingTo = { ...state.replyingTo }
        if (quote) replyingTo[botId] = quote
        else delete replyingTo[botId]
        return { replyingTo }
      })
    },

    async send(botId) {
      const typed = expandComposerThreadChips(expandComposerQuotes(get().drafts[botId] ?? '')).trim()
      // A bot of another computer takes words and files; this computer's threads are not sent there.
      const remote = isRemoteBot(botId)
      const attachments = get().attachments[botId] ?? []
      const references = remote ? [] : get().references[botId] ?? []
      const replyTo = get().replyingTo[botId]
      // Each thread pill goes as its link on a line of its own: the chat shows it as the thread's chip, and the bot reads
      // the thread by reference.
      const text = [typed, references.flatMap((reference) => (reference.threadId ? [threadLink(reference.threadId)] : [])).join('\n')].filter(Boolean).join('\n\n')
      if (!text && !attachments.length) return
      const refusal = attachmentsRefusal(attachments, remote)
      if (refusal) {
        set({ error: refusal, errorBotId: botId })
        return
      }
      const owner = epoch
      // The same words sent again after a failure reuse their request id, so they are not sent twice. Words sent
      // again while the first are still on their way are a second message, with their own id.
      const previous = failedSends.get(botId)
      const admission = previous?.text === text ? previous : { text, clientRequestId: crypto.randomUUID() }
      failedSends.delete(botId)
      const shown: BotChatMessage = {
        seq: Number.MAX_SAFE_INTEGER, id: pendingId(admission.clientRequestId), at: new Date().toISOString(), author: 'owner', kind: 'text',
        text, chips: [], ...(attachments.length ? { attachments: attachments.map((attached) => ({ name: attached.file.name, path: '', ...(attached.previewUrl ? { previewUrl: attached.previewUrl } : {}) })) } : {}),
        ...(replyTo ? { replyTo } : {})
      }
      set((state) => ({
        error: null,
        drafts: { ...state.drafts, [botId]: '' },
        attachments: { ...state.attachments, [botId]: [] },
        references: { ...state.references, [botId]: [] },
        replyingTo: withoutKey(state.replyingTo, botId),
        pending: { ...state.pending, [botId]: [...(state.pending[botId] ?? []), shown] }
      }))
      try {
        const files = await Promise.all(attachments.map(attachmentOf))
        const [message] = placeRemoteFiles(botId, [await bots().send(botId, text, admission.clientRequestId, files, replyTo?.id)])
        // The pictures shown while sending go to the sent message's files (unless its copy came first and took them);
        // any left over are no longer needed.
        if (owner === epoch) handOverPreviews(botId, [shown], [message!])
        for (const attached of attachments) {
          if (attached.previewUrl && !handedOver.delete(attached.previewUrl)) URL.revokeObjectURL(attached.previewUrl)
        }
        if (owner !== epoch) return
        set((state) => ({ pending: { ...state.pending, [botId]: (state.pending[botId] ?? []).filter((entry) => entry.id !== shown.id) } }))
        putConfirmed(botId, [message!])
      } catch (cause) {
        if (owner !== epoch) return
        // Nothing was sent: the words and files go back into the composer.
        failedSends.set(botId, admission)
        set((state) => ({
          error: errorText(cause),
          errorBotId: botId,
          drafts: { ...state.drafts, [botId]: state.drafts[botId] || typed },
          // The unsent threads come back, before any pasted while it was sending.
          references: { ...state.references, [botId]: [...references, ...(state.references[botId] ?? []).filter((entry) => !references.some((sent) => sent.id === entry.id))] },
          attachments: { ...state.attachments, [botId]: state.attachments[botId]?.length ? state.attachments[botId]! : attachments },
          replyingTo: replyTo && !state.replyingTo[botId] ? { ...state.replyingTo, [botId]: replyTo } : state.replyingTo,
          pending: { ...state.pending, [botId]: (state.pending[botId] ?? []).filter((entry) => entry.id !== shown.id) }
        }))
      }
    },

    async retry(botId, messageId) {
      const messages = cacheOf(botId).messages
      const failed = messages.find((message) => message.id === messageId)
      const again = failed ? botRetryOf(messages, failed) : null
      if (!again) return
      const owner = epoch
      const clientRequestId = retrySends.get(messageId) ?? crypto.randomUUID()
      retrySends.set(messageId, clientRequestId)
      set({ error: null })
      try {
        // A file of a bot of another computer is sent again from its copy here, read first when there is none.
        const files = await filesToSend(botId, again.attachments, readRemoteFile)
        const message = await bots().send(botId, again.text, clientRequestId, files, again.replyTo)
        if (owner !== epoch) return
        putMessages(botId, [message])
      } catch (cause) { fail(owner, cause, botId) }
    },

    async stop(botId) {
      const owner = epoch
      noteBotStopAsked(botId)
      try { await bots().stop(botId); if (owner === epoch) void get().refresh() } catch (cause) { fail(owner, cause, botId) }
    },

    async stopWork(botId, workId) {
      const owner = epoch
      try { await bots().stopWork(botId, workId); if (owner === epoch) void get().refresh() } catch (cause) { fail(owner, cause, botId) }
    },

    async answer(botId, askId, answer) {
      const owner = epoch
      set({ error: null })
      try {
        const message = await bots().answer(botId, askId, answer)
        if (owner !== epoch) return
        putMessages(botId, [message])
        void get().refresh()
      } catch (cause) { fail(owner, cause, botId) }
    },

    async snoozeReminder(botId, messageId, choice) {
      const owner = epoch
      set({ error: null })
      try {
        const message = await bots().snoozeReminder(botId, messageId, choice)
        if (owner !== epoch) return false
        putMessages(botId, [message])
        void get().refresh()
        return true
      } catch (cause) {
        if (owner !== epoch) return false
        if (missingMethod(cause)) set({ snoozeMissing: true })
        else fail(owner, cause, botId)
        void get().loadChat(botId)
        return false
      }
    },
    async answerAction(botId, actionId, digest, answer) {
      const card = get().chats[botId]?.messages.find(message => message.action?.actionId === actionId)?.action
      const names = { botName: get().bots.find(bot => bot.id === botId)?.name, serverName: card?.serverName }
      const owner = epoch
      try {
        await bots().answerAction(botId, actionId, digest, answer)
        if (owner === epoch) { await get().loadChat(botId); void get().refresh() }
        return null
      } catch (cause) {
        if (owner !== epoch) throw cause
        await get().loadChat(botId)
        const refusal = botActionRefusal(cause, names)
        // A gone row unmounts its card, so its refusal belongs in the chat's existing notice.
        if (owner === epoch && !get().chats[botId]?.messages.some(message => message.action?.actionId === actionId)) fail(owner, refusal ? { message: refusal.text } : cause, botId)
        return refusal ?? { reason: String((cause as { code?: unknown } | null)?.code ?? 'request_failed'), text: errorText(cause) }
      }
    },
    async answerChainHold(botId, holdId, answer) {
      const owner = epoch
      try {
        await bots().answerChainHold(botId, holdId, answer)
      } finally {
        // Sent, stopped or answered elsewhere first: the chat and the card follow what the service holds now.
        if (owner === epoch) { void get().loadChat(botId); void get().refresh() }
      }
    },
    async answerQuestion(botId, questionId, choice) {
      const owner = epoch
      set({ error: null })
      try {
        // A tap is sent once: a second tap while it is on its way is the component's to hold off.
        const { message, question } = await bots().answerQuestion(botId, questionId, choice, crypto.randomUUID())
        if (owner !== epoch) return false
        putMessages(botId, question ? [question, message] : [message])
        void get().refresh()
        return true
      } catch (cause) {
        if (owner !== epoch) return false
        // An older service has no buttons for questions: they go, and the owner answers with Reply.
        if (missingMethod(cause)) set({ questionsMissing: true })
        else fail(owner, cause, botId)
        // Answered meanwhile (on another device) or no longer open: the chat reads the question as it is now.
        const code = String((cause as { code?: unknown } | null)?.code ?? '')
        if (code === 'question_answered' || code === 'question_closed') void get().loadChat(botId)
        return false
      }
    },

    async react(botId, messageId, emoji) {
      const owner = epoch
      const before = get().chats[botId]?.messages.find((message) => message.id === messageId)
      if (!before) return
      const key = `${botId}:${messageId}`
      const pick = ++reactionPicks
      const entry = reactions.get(key) ?? { confirmed: before.reaction, latest: pick }
      entry.latest = pick
      reactions.set(key, entry)
      const shown = (reaction: string | undefined) => {
        const now = get().chats[botId]?.messages.find((message) => message.id === messageId)
        if (!now) return
        const { reaction: _old, ...rest } = now
        putMessages(botId, [reaction === undefined ? rest : { ...rest, reaction }])
      }
      shown(emoji ?? undefined)
      set({ error: null })
      try {
        const message = await bots().react(botId, messageId, emoji)
        if (owner !== epoch) return
        entry.confirmed = message.reaction
        if (entry.latest !== pick) return
        reactions.delete(key)
        putMessages(botId, [message])
      } catch (cause) {
        if (owner !== epoch || entry.latest !== pick) return
        reactions.delete(key)
        shown(entry.confirmed)
        // An older service has no reactions: the bar goes, with nothing to read.
        if (missingMethod(cause)) set({ reactionsMissing: true })
        else fail(owner, cause, botId)
      }
    },

    async loadMemory(botId) {
      const owner = epoch
      try {
        const listing = await bots().memory(botId)
        if (owner !== epoch) return
        const entries = listing.entries.filter((entry) => entry.status === 'active' && entry.text)
        set((state) => ({ memory: { ...state.memory, [botId]: keepEqualById(state.memory[botId] ?? [], entries) }, memoryError: withoutKey(state.memoryError, botId) }))
      } catch (cause) {
        if (owner === epoch) set((state) => ({ memoryError: { ...state.memoryError, [botId]: errorText(cause) } }))
      }
    },

    openMemory(botId, focus) {
      set({ memoryOpen: { botId, ...(focus ? { focus } : {}) } })
      void get().loadMemory(botId)
    },

    closeMemory() { set({ memoryOpen: null }) },

    async forgetMemory(botId, id) {
      const owner = epoch
      try {
        await bots().forgetMemory(botId, id)
        if (owner === epoch) set((state) => ({ memory: { ...state.memory, [botId]: (state.memory[botId] ?? []).filter((entry) => entry.id !== id) } }))
        return null
      } catch (cause) {
        return errorText(cause)
      }
    },

    async editMemory(botId, ref, text) {
      const owner = epoch
      try {
        const entry = await bots().editMemory(botId, ref, text)
        if (owner === epoch) set((state) => ({ memory: { ...state.memory, [botId]: (state.memory[botId] ?? []).map((item) => (item.id === entry.id ? entry : item)) } }))
        return null
      } catch (cause) {
        if (missingMethod(cause)) {
          set({ memoryEditMissing: true })
          return 'This computer’s Mousse can’t edit memory yet.'
        }
        return errorText(cause)
      }
    },

    askAboutMemory(botId, text) {
      // The composer's reply pill, at the end of what is already typed; on send it becomes the words in quotes.
      const token = registerQuote(text)
      set((state) => {
        const draft = state.drafts[botId] ?? ''
        return { memoryOpen: null, drafts: { ...state.drafts, [botId]: insertQuoteToken(draft, draft.length, draft.length, token).value } }
      })
      window.requestAnimationFrame(() => {
        const field = document.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')
        field?.focus()
        field?.setSelectionRange(field.value.length, field.value.length)
      })
    },

    async exportMemory(botId, askId) {
      const owner = epoch
      set({ error: null })
      try {
        const dir = await window.mousse.dialog.pickFolder({ title: 'Choose a folder for the bot’s memory', buttonLabel: 'Save here' })
        // Cancelled: the card stays open, so the owner can pick again or say Not now.
        if (!dir || owner !== epoch) return
        await bots().exportMemory(botId, dir)
        if (owner !== epoch) return
        const message = await bots().answer(botId, askId, 'allow')
        if (owner === epoch) putMessages(botId, [message])
      } catch (cause) { fail(owner, cause, botId) }
    },

    openNewBot() { set({ newBotOpen: true, error: null, errorBotId: null }) },

    closeNewBot() { set({ newBotOpen: false, error: null }) },

    setNewBotDraft(change) { set((state) => ({ newBotDraft: { ...state.newBotDraft, ...change, touched: true } })) },

    seedNewBotRows(last, offered) {
      set((state) => {
        const rows = state.newBotDraft.slots ?? last
        const keep = (pick: BotModelPick | null | undefined) => (pick && offered(pick) ? pick : null)
        return { newBotDraft: { ...state.newBotDraft, slots: { talk: keep(rows?.talk), light: keep(rows?.light), medium: keep(rows?.medium), hard: keep(rows?.hard) } } }
      })
    },

    setNewBotStep(step) { set((state) => ({ error: state.errorBotId === null ? null : state.error, newBotDraft: { ...state.newBotDraft, step } })) },

    create(input) {
      if (createOperation) return createOperation
      const owner = epoch
      const key = JSON.stringify(input)
      if (pendingCreate?.key !== key) pendingCreate = { key, clientRequestId: crypto.randomUUID() }
      const clientRequestId = pendingCreate.clientRequestId
      set({ busy: true, error: null, errorBotId: null })
      const operation = (async () => {
        try {
          const bot = await bots().create({ ...input, clientRequestId })
          if (owner !== epoch) return null
          pendingCreate = undefined
          created.add(bot.id)
          set((state) => ({ bots: replaceBot(state.bots, bot), busy: false, newBotOpen: false, newBotDraft: EMPTY_NEW_BOT }))
          return bot
        } catch (cause) {
          if (owner !== epoch) return null
          set((state) => ({ error: createFailureText(cause), errorBotId: null, busy: false, newBotDraft: { ...state.newBotDraft, step: newBotStepForFailure(cause, state.newBotDraft.step) } }))
          // An answer that never came may still have made the bot: the list shows it if so.
          void get().refresh()
          return null
        }
      })()
      createOperation = operation
      void operation.finally(() => { if (createOperation === operation) createOperation = undefined })
      return operation
    },

    async update(botId, change) {
      const owner = epoch
      set({ busy: true, error: null })
      try {
        const bot = await bots().update(botId, change)
        if (owner !== epoch) return false
        putBot(bot)
        set({ busy: false })
        return true
      } catch (cause) { fail(owner, cause, botId); return false }
    },

    async setPrompt(botId, description) {
      const owner = epoch
      try {
        const bot = await bots().update(botId, { description })
        if (owner === epoch) putBot(bot)
        return null
      } catch (cause) {
        return errorText(cause)
      }
    },

    async pause(botId) {
      const owner = epoch
      try { const bot = await bots().pause(botId); if (owner === epoch) putBot(bot) } catch (cause) { fail(owner, cause, botId) }
    },

    async resume(botId) {
      const owner = epoch
      try { const bot = await bots().resume(botId); if (owner === epoch) putBot(bot) } catch (cause) { fail(owner, cause, botId) }
    },

    async makePrivate(botId) {
      const owner = epoch
      try {
        await bots().setDevices(botId, { mode: 'this_computer' })
        if (owner !== epoch) return
        // The list's lock shows at once; the service's `bots.changed` reads it again too.
        set((state) => ({ bots: state.bots.map((bot) => (bot.id === botId ? { ...bot, reach: 'this_computer' } : bot)) }))
      } catch (cause) { fail(owner, cause, botId) }
    },

    async remove(botId) {
      const owner = epoch
      set({ busy: true, error: null })
      try {
        await bots().remove(botId)
        if (owner !== epoch) return false
        removed.add(botId)
        set((state) => {
          const { [botId]: _chat, ...chats } = state.chats
          const { [botId]: _detail, ...details } = state.details
          const { [botId]: _live, ...live } = state.live
          const { [botId]: _pending, ...pending } = state.pending
          return { bots: state.bots.filter((bot) => bot.id !== botId), chats, details, live, pending, busy: false, dialog: null, aboutOpen: false }
        })
        return true
      } catch (cause) { fail(owner, cause, botId); return false }
    },

    async loadDetail(botId) {
      const owner = epoch
      try {
        const detail = await bots().get(botId)
        if (owner === epoch && !removed.has(botId)) set((state) => ({ details: { ...state.details, [botId]: detail }, bots: replaceBot(state.bots, detail.summary) }))
      } catch (cause) { fail(owner, cause, botId) }
    },

    async setPermission(botId, permissionId, enabled) {
      const owner = epoch
      try {
        const detail = await bots().setPermission(botId, permissionId, enabled)
        if (owner === epoch) set((state) => ({ details: { ...state.details, [botId]: detail } }))
      } catch (cause) { fail(owner, cause, botId) }
    },

    async revokePermission(botId, permissionId) {
      const owner = epoch
      try {
        const detail = await bots().revokePermission(botId, permissionId)
        if (owner === epoch) set((state) => ({ details: { ...state.details, [botId]: detail } }))
      } catch (cause) { fail(owner, cause, botId) }
    },

    async removeSchedule(botId, scheduleId) {
      const owner = epoch
      try {
        const detail = await bots().removeSchedule(botId, scheduleId)
        if (owner === epoch) set((state) => ({ details: { ...state.details, [botId]: detail } }))
      } catch (cause) { fail(owner, cause, botId) }
    },

    async cancelReminder(botId, reminderId) {
      const owner = epoch
      try {
        const detail = await bots().cancelReminder(botId, reminderId)
        if (owner === epoch) set((state) => ({ details: { ...state.details, [botId]: detail } }))
      } catch (cause) { fail(owner, cause, botId) }
    }
  }
})

// A live reply follows its bot's chat turn and its chat's messages: it goes once its message is posted.
setBotLiveReplySources({ bots: () => useBotsStore.getState().bots, messages: (botId) => useBotsStore.getState().chats[botId]?.messages ?? [] })
useBotsStore.subscribe((state, previous) => { if (state.bots !== previous.bots || state.chats !== previous.chats) noteBots() })

/** Failures whose words come from the service and are meant for the owner as they are. */
const PLAIN_CREATE_FAILURES = new Set(['invalid_params', 'bot_invalid', 'bots_unavailable', 'model_unavailable'])

/**
 * What New bot says when Create bot fails. No answer, a lost connection or an unexpected error all
 * mean the same to the owner: try again, which reuses the request and never makes the bot twice.
 */
export function createFailureText(cause: unknown): string {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : ''
  const text = errorText(cause)
  if (PLAIN_CREATE_FAILURES.has(code) && text) return text
  return 'Mousse couldn’t finish making the bot. What you wrote is kept: press Create bot to try again. It won’t make the same bot twice.'
}

let pollers = 0
let pollTimer: ReturnType<typeof setInterval> | undefined

/** A poll tick: a hidden window (minimised) lists nothing, and lists again as soon as it shows. */
function pollVisible(): void {
  if (document.visibilityState !== 'hidden') void useBotsStore.getState().refresh()
}

/**
 * Lists the bots now and every 30 seconds while a view that shows them is mounted: the Chats tab's
 * sidebar and the chat pane. The sidebar can be shown without the pane (after a restart the pane
 * opens on Projects), so each lists them; they share one timer. A hidden window skips the ticks.
 */
export function useBotsPolling(): void {
  const profileId = useBotsStore((s) => s.profileId)
  useEffect(() => {
    void useBotsStore.getState().refresh()
    pollers += 1
    if (pollTimer === undefined) {
      pollTimer = setInterval(pollVisible, POLL_MS)
      document.addEventListener('visibilitychange', pollVisible)
    }
    return () => {
      pollers -= 1
      if (pollers === 0 && pollTimer !== undefined) {
        clearInterval(pollTimer)
        pollTimer = undefined
        document.removeEventListener('visibilitychange', pollVisible)
      }
    }
  }, [profileId])
}
