import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import { File as FileIcon, GitFork, IconPhoto, MessageSquare, Mic, RefreshCw, Reply, X } from '../lib/icons'
import type {
  BrowserElementAttachment,
  FileSearchResponse,
  SkillChatMode
} from '../../shared/types'
import type { SkillDescriptor } from '../../shared/integrations'
import {
  applyMentionPick,
  filterComposerCommandSuggestions,
  filterSkillSuggestions,
  findInlineSkillToken,
  findMentionQueryAtCaret,
  findSlashQueryAtCaret,
  isImeComposing,
  isMentionResultCurrent,
  mentionItemReference,
  mergeMentionSuggestions,
  moveSelection,
  parseSkillsPickerQuery,
  pickerKeyAction,
  removeInlineSkillToken,
  slashSuggestions,
  type ComposerCommandDef,
  type MentionItem
} from '../../shared/composerCommands'
import { CommandRowContent, ComposerSuggestionList, MarkedText, markQuery, MentionRowContent, SkillRowContent, type SuggestionRow } from './ComposerSuggestionList'
import { ComposerFooter, STEER_BINDING, formatRecordingTime as formatDuration, isSteerKey, type ComposerRunProps } from './ComposerFooter'
import { markSteerKey, steersOnEnter, type SendMode } from '../lib/steerKey'
import { useThreadSendMode } from '../lib/sendMode'
import { BrowserElementPill } from './BrowserElementPill'
import { FileAttachment } from '../chat/components/agent-elements/input/file-attachment'
import { ImageGalleryProvider } from '../chat/components/agent-elements/image-gallery'
import { formatBrowserElementBlock } from '../utils/messageAttachments'
import { collectFilesFromDataTransfer } from '../utils/imageAttachments'
import { fileAttachments } from '../lib/composerFilePaths'
import { ATTACHMENT_LINES_ROOM, isLongPaste, longPasteFile, pastedTextBlock, pastedTextName } from '../lib/longPaste'
import { PastedTextPreview } from './PastedTextPreview'
import { formatAttachedFilesMarker } from '../../shared/attachedFilesMarker'
import type { ChatReference } from '../../shared/chatReferences'
import { formatChatReferences, MOUSSE_REFERENCE_MIME, parseChatReference, parseReferenceDragData } from '../../shared/chatReferences'
import { ownFileDrop, startDragOut } from '../lib/fileDragOut'
import { ChatReferencePill, REFERENCE_ICONS, openChatReference, referenceTitle } from './ReferencePill'
import { threadIdsInText } from '../lib/threadReference'
import { insertTranscript } from '../dictation/insertTranscript'
import { useDictation } from '../dictation/useDictation'
import { useCommand } from '../commands/commandRegistry'
import { formatBinding } from '../../shared/commands'
import { useAppStore } from '../stores/appStore'
import { openSettingsSection } from '../lib/settingsNavigation'
import { COMPOSER_SEND_EVENT } from '../lib/composerEvents'
import { takesConnectingHandover, useServiceConnecting } from '../lib/serviceConnection'
import { CONNECTING_TEXT, ConnectingDots } from './ConnectingDots'
import { useComposerNotice } from './ComposerNotice'
import { composerMarkdownSpans, listContinuation, type MarkdownKind } from '../lib/composerMarkdown'
import {
  COMPOSER_QUOTE_EVENT,
  QUOTE_TAG_LENGTH,
  deleteQuoteTokenAt,
  expandComposerQuotes,
  findQuoteTokens,
  insertQuoteToken,
  quoteRegistry,
  quoteTokenAround,
  registerQuote,
  type ComposerQuoteDetail
} from '../lib/composerQuotes'
import {
  chipThreadLinks,
  expandComposerThreadChips,
  findThreadChips,
  rangeOverChips,
  registerThreadChip,
  threadChipAround,
  threadChipAtEdge,
  threadChipLabel,
  threadChipParts,
  threadChipRegistry
} from '../lib/composerThreadChips'
import { threadLinkStatus } from '../../shared/threadAttention'
import { openFileInPanel, openLinkedThread } from '../utils/chatLinks'
import {
  attachmentChipKey,
  attachmentChipParts,
  attachmentChipRegistry,
  chipInsertion,
  expandComposerAttachmentChips,
  findAttachmentChips,
  hasTextAround,
  referenceChipKey,
  registerAttachmentChip,
  unregisterAttachmentChips,
  wordEdge,
  plainOrphanChips,
  ATTACHMENT_CHIP_HEAD,
  type AttachmentChipEntry,
  type AttachmentChipSpan
} from '../lib/composerAttachmentChips'
import { formatSentChip } from '../../shared/inlineAttachments'
import {
  botChipParts,
  botChipRegistry,
  chipBotTags,
  expandComposerBotChips,
  findBotChips,
  matchTaggableBots,
  registerBotChip,
  type TaggableBot
} from '../lib/composerBotChips'
import { DEFAULT_BOT_LOOK, BOT_COLOUR_HEX, normalizeBotLook, type BotLook } from '../../shared/bots/personal/look'
import { BotFace } from './bots/face/BotFace'

import { admitAttachments, type ChipStatus } from '../lib/attachmentPreparation'
import { countRender } from '../chat/components/agent-elements/render-counts'

export interface AttachedFile {
  id: string
  file: File
  previewUrl?: string
  /** Where the file already is on the thread's computer (a queued message given back): sent as this path. */
  path?: string
  /** What the chip and the message call the file, when not its file name: "Pasted text, 1,240 lines". */
  label?: string
  /** A long text paste kept as a file: it can be opened, and put back into the box as text. */
  pastedText?: boolean
  /** An image sent as its path, not inline: its original beside a smaller copy, or one that can't go inline. */
  asPath?: boolean
}

/** What the chip and the message call an attached file. */
export const attachedFileName = (attached: AttachedFile): string => attached.label ?? attached.file.name

export interface VoiceMessage {
  id: string
  blob: Blob
  duration: number
  url: string
}

/** A row of the composer's own `/` list (`commandSuggestions`): its label and action, and the text picking it puts in. */
export interface ComposerCommandSuggestion {
  key: string
  label: string
  description: string
  /** The box's text after picking it. */
  fill: string
  /** Enter (or a click) on it sends the box when it already reads `fill`, so a finished command runs in one press. */
  complete: boolean
}

const NO_COMMAND_SUGGESTIONS: ComposerCommandSuggestion[] = []

export interface ChatComposerProps {
  input: string
  onInputChange: (value: string) => void
  attachedFiles: AttachedFile[]
  onAttachedFilesChange: (files: AttachedFile[]) => void
  voiceMessages: VoiceMessage[]
  onVoiceMessagesChange: (voices: VoiceMessage[]) => void
  browserElements?: BrowserElementAttachment[]
  onRemoveBrowserElement?: (id: string) => void
  references?: ChatReference[]
  /** Without it the composer takes no references: a dragged chat or thread is not dropped here. */
  onAddReference?: (reference: ChatReference) => void | Promise<void>
  onRemoveReference?: (id: string) => void
  onReferenceError?: (message: string) => void
  /** Why a pasted thread link may not go in this chat, else null; a refused paste is not inserted. */
  pastedThreadRefusal?: (threadId: string) => string | null
  enabledSkills: SkillDescriptor[]
  /**
   * The model picker and context ring (see `ComposerFooter`). A thread's composer has them; a bot's
   * has none, as a bot picks its own model.
   */
  run?: ComposerRunProps
  /** `/` commands (`/clear`, `/compact`, …) are offered while typing; a bot's composer has none. */
  slashCommands?: boolean
  /**
   * The parent's own `/` list (a bot's chat commands): the rows for what the box holds now, or none. Shown with the same
   * keys as the thread's list: arrows move, Enter and Tab pick, Escape closes.
   */
  commandSuggestions?: (input: string) => ComposerCommandSuggestion[]
  loading?: boolean
  /** A run Stop can end, including one waiting on an approval or an answer; defaults to `loading`. */
  stoppable?: boolean
  disabled?: boolean
  placeholder?: string
  /**
   * Receives the inline `@skill` token (if any) so the parent can send this
   * prompt in skill mode without flipping the global chat mode. `steer` is set
   * when the text was sent as a steer during a run: it goes into the running turn.
   */
  onSend: (skillMode?: SkillChatMode, options?: { steer?: boolean; alsoSubagents?: boolean }) => void
  /**
   * The thread has subagents still working: "Also tell subagents" shows, on by default for a steer and off for any other
   * message, and `alsoSubagents` goes with the send when it is on (docs/plans/tool-api.md §2.5).
   */
  tellSubagents?: boolean
  /**
   * The steer chord in an empty composer while a reply runs: sends the next queued message into the reply now.
   * Returns whether one was sent.
   */
  onSteerQueued?: () => boolean
  /** What the send button says it does, when the parent sends somewhere other than the thread (see `ComposerFooter`). */
  sendLabel?: string
  onStop?: () => void
  /** The thread's last sent prompt, which Up in an empty box brings back. */
  lastPrompt?: () => string | undefined
  /** When true, `/skills` is treated as literal text instead of opening the skill picker. */
  disableSkillsPicker?: boolean
  /** A row above the input, such as a subagent asking a question; it brings its own layout. */
  banner?: ReactNode
  /**
   * Bots the `@` list offers to tag (a bot's chat: the owner's other bots). A pick leaves the bot's chip, its face and
   * name, which goes as the bot's tag (`lib/composerBotChips.ts`); a tag of one of them typed, pasted or brought back
   * by Up becomes its chip too.
   */
  mentionBots?: readonly TaggableBot[]
  /** Searches the project's files and folders for an `@` mention; rejects when there is no project to search. */
  searchMentions?: (query: string) => Promise<FileSearchResponse>
  /**
   * Which thread and project `searchMentions` answers for. Results from another scope are
   * dropped, and picked files get this thread and project on their reference.
   */
  mentionScope?: { scopeKey: string; threadId?: string; projectId?: string }
  /** The thread's permission mode and how to change it (see `ComposerFooter`). */
  permission?: ComponentProps<typeof ComposerFooter>['permission']
  /** Buttons of the caller's own in the footer, left of Attach (see `ComposerFooter`). */
  extraActions?: ReactNode
  /**
   * The thread whose composer Enter follows the profile's send mode in (Queue or Steer, `lib/sendMode.ts`) while a
   * reply runs; the mode button left of send shows and switches it for every thread. Absent (a bot's chat, which never steers): Enter queues and there is
   * no button.
   */
  sendModeThreadId?: string
  /** The most characters a message carries: text pasted past it goes on the message as a text file. */
  messageLimit?: number
  /** What getting each attached image ready came to, by attachment id (`useAttachmentPreparation`): shown on its chip. */
  attachmentStatus?: ReadonlyMap<string, ChipStatus>
  /** Why Send is held (an attachment still being prepared, or one that can't be sent); Send stays disabled with this tooltip. */
  sendBlocked?: string | null
  /**
   * Files attached here are checked as they come (`admitAttachments`): one the message can't take is not attached, and
   * `onRefused` gets a line naming it. `remote`: the thread runs on another computer, which takes images only.
   */
  attachRules?: { remote: boolean; onRefused: (line: string) => void }
  /**
   * Whether the composer says Connecting…; by default, while the app is not connected to its service
   * (`useServiceConnecting`). Its placeholder says so, dots move behind its text and its toolbar's controls fade out;
   * the draft stays and can be edited, and nothing is sent.
   */
  connecting?: boolean
  /** Enter while connecting still reaches `onSend`: the parent keeps the message and sends it once connected. */
  sendsWhenConnected?: boolean
}

/** A chip under the pointer: a thread chip (and whether on its remove mark) or an attachment chip, by its place in its list. */
/** A row of the `@` list: a skill, a file or folder, or a bot to tag. */
type ComposerMention = MentionItem<SkillDescriptor> | { kind: 'bot'; bot: TaggableBot }

interface ChipHit {
  kind: 'thread' | 'attachment'
  index: number
  close: boolean
}

/** What a copied selection with chips carries for this composer, so pasting it back keeps the chips. */
const COMPOSER_TEXT_MIME = 'application/x-mousse-composer-text'

const MENTION_SEARCH_DEBOUNCE_MS = 120
const MENTION_INDEXING_RETRY_MS = 500
const MENTION_ROW_LIMIT = 20

interface MentionSearchState {
  scopeKey: string
  query: string
  /** Absolute root the result paths are relative to. */
  root: string
  results: FileSearchResponse['results']
  indexing: boolean
  truncated: boolean
  /** The search was refused (no project, or an older service). */
  failed: boolean
}

/** Caret of a text box, or -1 while a range is selected. */
/**
 * A kept-mounted pane that is not the one in view is inert; its composer must not answer shortcuts. A side chat's
 * composer answers only while focus is in that side chat: the thread's own composer keeps every other key.
 */
function isShown(input: HTMLElement | null): boolean {
  if (input?.closest('[inert]')) return false
  const sideChat = input?.closest('[data-side-chat]')
  return !sideChat || sideChat.contains(document.activeElement)
}

function readCaret(node: HTMLTextAreaElement): number {
  return node.selectionStart === node.selectionEnd ? node.selectionStart : -1
}

export function ChatComposer({
  input,
  onInputChange,
  attachedFiles,
  onAttachedFilesChange,
  voiceMessages,
  onVoiceMessagesChange,
  browserElements = [],
  onRemoveBrowserElement = () => {},
  references = [],
  onAddReference,
  onRemoveReference = () => {},
  onReferenceError = () => {},
  pastedThreadRefusal,
  enabledSkills,
  run,
  slashCommands = true,
  commandSuggestions,
  loading = false,
  stoppable = loading,
  disabled = false,
  placeholder,
  onSend,
  onSteerQueued,
  tellSubagents = false,
  sendLabel,
  onStop,
  lastPrompt,
  disableSkillsPicker = false,
  banner,
  mentionBots,
  searchMentions,
  mentionScope,
  permission,
  sendModeThreadId,
  extraActions,
  messageLimit = Infinity,
  attachmentStatus,
  sendBlocked = null,
  attachRules,
  connecting: connectingProp,
  sendsWhenConnected = false
}: ChatComposerProps) {
  countRender('ChatComposer')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentsRowRef = useRef<HTMLDivElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  const serviceConnecting = useServiceConnecting()
  // Taking the warm start composer's place, this one starts as that one ended (Connecting…) and fades to connected.
  const [handover, setHandover] = useState(() => connectingProp === undefined && takesConnectingHandover())
  useEffect(() => {
    if (!handover) return
    // Two frames: the first paints it as the warm start left it, so the fade starts from there.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setHandover(false)) })
    return () => cancelAnimationFrame(frame)
  }, [handover])
  const connecting = connectingProp ?? (serviceConnecting || handover)
  // A model menu left open when the connection dropped closes with the rest of the toolbar.
  const closeModelMenu = run?.modelMenuOpen ? run.onModelMenuOpenChange : undefined
  useEffect(() => { if (connecting) closeModelMenu?.(false) }, [connecting, closeModelMenu])
  // The send mode is a choice only while a reply runs: idle, Enter just sends. A card that takes the message (an open
  // question, a waiting approval: `sendLabel`) keeps Enter for itself.
  const [threadSendMode, setThreadSendMode] = useThreadSendMode(sendModeThreadId)
  const sendModeShown = Boolean(sendModeThreadId) && loading && !sendLabel
  const sendMode: SendMode = sendModeShown ? threadSendMode : 'queue'
  const switchSendMode = () => setThreadSendMode(sendMode === 'steer' ? 'queue' : 'steer')
  // "Also tell subagents": the person's own choice for this message, else on for a steer and off for any other.
  const [tellChoice, setTellChoice] = useState<boolean | null>(null)
  const tellOn = tellChoice ?? sendMode === 'steer'
  useCommand('composer.switchSendMode', switchSendMode, () => sendModeShown && !disabled && isShown(composerInputRef.current))
  // The prompt Up brought back, until it is sent or edited: Escape clears it again.
  const recalledRef = useRef<string | null>(null)
  // Two composers can be mounted at once (the local thread behind a remote one): the shown one answers.
  useCommand('composer.focus', () => composerInputRef.current?.focus(), () => !disabled && isShown(composerInputRef.current))
  const backdropRef = useRef<HTMLDivElement>(null)
  const resizeDraft = useCallback(() => {
    const inputElement = composerInputRef.current
    if (!inputElement) return
    inputElement.style.height = '0px'
    const height = Math.max(64, Math.min(200, inputElement.scrollHeight))
    inputElement.style.removeProperty('height')
    inputElement.style.setProperty('--draft-input-height', `${height}px`)
    if (backdropRef.current) backdropRef.current.scrollTop = inputElement.scrollTop
  }, [])
  useLayoutEffect(() => { resizeDraft() }, [input, resizeDraft])
  useEffect(() => {
    const inputElement = composerInputRef.current
    if (!inputElement) return
    let width = inputElement.clientWidth
    const observer = new ResizeObserver(() => {
      if (inputElement.clientWidth !== width) {
        width = inputElement.clientWidth
        resizeDraft()
      }
    })
    observer.observe(inputElement)
    return () => observer.disconnect()
  }, [resizeDraft])

  const suggestionRefs = useRef(new Map<number, HTMLButtonElement>())
  const registerSuggestionRow = (index: number, element: HTMLButtonElement | null) => {
    if (element) suggestionRefs.current.set(index, element)
    else suggestionRefs.current.delete(index)
  }
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  // Caret of the text box, or -1 while a range is selected (a range is never a mention).
  // Moving the caret across ordinary text does not trigger a React re-render; state updates only
  // when entering, moving within, or leaving an `@mention` or mid-message `/skill` query.
  const caretRef = useRef(0)
  const mentionCaretRef = useRef(0)
  const [caret, setCaretState] = useState(0)
  const setCaret = useCallback((next: number, value = inputValueRef.current) => {
    caretRef.current = next
    const inQuery = (at: number) => findMentionQueryAtCaret(value, at) !== null || findSlashQueryAtCaret(value, at) !== null
    if (!inQuery(next) && !inQuery(mentionCaretRef.current)) return
    if (next === mentionCaretRef.current) return
    mentionCaretRef.current = next
    setCaretState(next)
  }, [])
  // True between compositionstart and compositionend of an input method.
  const composingRef = useRef(false)
  const [mentionSearch, setMentionSearch] = useState<MentionSearchState | null>(null)
  const searchMentionsRef = useRef(searchMentions)
  searchMentionsRef.current = searchMentions
  const currentMentionRef = useRef<{ scopeKey: string; query: string }>({ scopeKey: '', query: '' })
  const shownMentionKeyRef = useRef('')
  const inputValueRef = useRef(input)
  inputValueRef.current = input
  // The selection (or caret) when dictation started, with the text it was taken from.
  const dictationRangeRef = useRef<{ start: number; end: number; value: string } | null>(null)
  // Dictated text replaces the selection made before dictation started, even if the caret moved since.
  // If the text changed while recording, that range no longer means the same words, so it goes at the caret.
  // Then the box gets focus.
  const insertDictation = (text: string) => {
    const node = composerInputRef.current
    const current = node?.value ?? inputValueRef.current
    const range = dictationRangeRef.current
    dictationRangeRef.current = null
    const start = range && range.value === current ? range.start : node?.selectionStart ?? current.length
    const end = range && range.value === current ? range.end : node?.selectionEnd ?? current.length
    const inserted = insertTranscript(current, start, end, text)
    setSuggestionsDismissed(false)
    setSelectedSuggestion(0)
    onInputChange(inserted.value)
    requestAnimationFrame(() => {
      const target = composerInputRef.current
      if (!target) return
      target.focus()
      target.setSelectionRange(inserted.caret, inserted.caret)
    })
  }
  const dictation = useDictation({ disabled, onTranscript: insertDictation })
  const { isRecording, recordingPending, transcribing, recordingDuration } = dictation
  const startDictation = () => {
    const node = composerInputRef.current
    dictationRangeRef.current = node ? { start: node.selectionStart, end: node.selectionEnd, value: node.value } : null
    dictation.start()
  }
  // The dictation key starts recording, idle or while a run goes, and finishes it (Done) while recording.
  useCommand(
    'composer.dictate',
    () => (isRecording ? dictation.stop() : startDictation()),
    () => !disabled && isShown(composerInputRef.current) && (isRecording || (!connecting && !recordingPending && !transcribing))
  )
  const [pendingReferences, setPendingReferences] = useState(0)
  // Dictation and reference progress share the composer's one notice line, so the composer never changes height.
  useComposerNotice(pendingReferences > 0 ? { tone: 'info', title: 'Attaching reference…' } : null)
  useComposerNotice(recordingPending ? { tone: 'info', title: 'Requesting microphone access…' } : null)
  useComposerNotice(dictation.notice ? { tone: 'info', title: dictation.notice } : null)
  useComposerNotice(dictation.error ? {
    tone: 'error',
    title: dictation.error.message,
    actions: [{ label: 'Retry microphone', icon: <RefreshCw size={14} strokeWidth={1.8} />, disabled: disabled || recordingPending || transcribing, onClick: startDictation }],
    onDismiss: dictation.dismissError
  } : null)
  // With the picker disabled, `/skills` stays literal text so it is sent to the agent as a prompt.
  const skillsPickerDisabled = disableSkillsPicker
  // Inline `@skill` token embedded in the typed text (painted as a pill by
  // the input backdrop). The global chat mode is untouched: the skill applies
  // to the submitted prompt only (passed to onSend as a mode override), and
  // the token is stripped from the sent text. Backspace deletes it like text.
  const skillToken = skillsPickerDisabled
    ? null
    : findInlineSkillToken(input, enabledSkills)
  // Reply pills: text quoted from the conversation, at their place in the typed text (`lib/composerQuotes.ts`).
  const quoteSpans = useMemo(() => findQuoteTokens(input, quoteRegistry()), [input])
  // Thread chips: a thread's link shown as its chip at its place in the text (`lib/composerThreadChips.ts`). A thread
  // this window does not list, or one this chat may not point at, stays a link.
  const threadChips = useMemo(() => findThreadChips(input, threadChipRegistry()), [input])
  // Attachment chips: an attachment or reference placed among the text, at its place (`lib/composerAttachmentChips.ts`).
  const attachmentChips = useMemo(() => findAttachmentChips(input, attachmentChipRegistry()), [input])
  // Bot chips: a bot tagged with `@`, its face and name at its place (`lib/composerBotChips.ts`).
  const botChips = useMemo(() => findBotChips(input, botChipRegistry()), [input])
  // Every chip that edits as one character: thread chips, attachment chips and bot chips.
  const atomicChips = useMemo(
    () => (attachmentChips.length || botChips.length ? [...threadChips, ...attachmentChips, ...botChips].sort((a, b) => a.index - b.index) : threadChips),
    [threadChips, attachmentChips, botChips]
  )
  // Thread links become their chips, then the tags of the bots this composer offers become theirs.
  const chipLinks = (text: string, within?: { start: number; end: number }) => {
    const threads = chipThreadLinks(text, (threadId) => (pastedThreadRefusal?.(threadId) ? null : threadChipLabel(threadId)), registerThreadChip, within)
    if (!mentionBots?.length) return threads
    const range = within && { start: threads.map(within.start), end: threads.map(within.end) }
    const bots = chipBotTags(threads.value, (botId) => mentionBots.find((bot) => bot.id === botId)?.name ?? null, registerBotChip, range)
    return bots.value === threads.value ? threads : { value: bots.value, map: (offset: number) => bots.map(threads.map(offset)) }
  }
  const hasChipLinks = (text: string) => {
    const lower = text.toLowerCase()
    return lower.includes('mousse://thread/') || (Boolean(mentionBots?.length) && lower.includes('mousse://bot/'))
  }
  // The text box's value as its own typing last left it; any other `input` was set from outside (a draft, Up, a
  // queued message given back), and its links become chips.
  const nativeValueRef = useRef<string | null>(null)
  // A link the last typing may have finished (a space or new line after it), or a drop, to turn into a chip.
  const pendingChipRef = useRef<{ start: number; end: number } | null>(null)
  // True while the composer edits the text box itself, so that edit is not looked at again.
  const selfEditRef = useRef(false)
  const [chipHover, setChipHover] = useState<ChipHit | null>(null)
  const chipPressRef = useRef<ChipHit | null>(null)

  const hasAttachments = attachedFiles.length > 0 || voiceMessages.length > 0 || browserElements.length > 0 || references.length > 0
  const rowHasImages = attachedFiles.some((attached) => attached.previewUrl !== undefined && !attachmentStatus?.get(attached.id)?.noPreview)
  const trimmedInput = removeInlineSkillToken(input, skillsPickerDisabled ? [] : enabledSkills).trim()
  const skillsPickerQuery = skillsPickerDisabled ? null : parseSkillsPickerQuery(input)
  const skillSuggestions =
    skillsPickerQuery !== null ? filterSkillSuggestions(enabledSkills, skillsPickerQuery) : []
  const showSkillsPicker = !disabled && !suggestionsDismissed && skillsPickerQuery !== null

  // `@query` at the caret: skills, files and folders in one list. File rows show only while the
  // stored search belongs to the current thread, project and query, so a pick can never choose a
  // row from an earlier query or another thread.
  const mentionQuery = !disabled && skillsPickerQuery === null ? findMentionQueryAtCaret(input, caret) : null
  const mentionScopeKey = mentionScope?.scopeKey
  currentMentionRef.current = { scopeKey: mentionScopeKey ?? '', query: mentionQuery?.query ?? '' }
  const mentionResult =
    mentionQuery && mentionScopeKey && mentionSearch &&
    isMentionResultCurrent(mentionSearch, { scopeKey: mentionScopeKey, query: mentionQuery.query })
      ? mentionSearch
      : null
  const fileMentions: MentionItem<SkillDescriptor>[] = mentionQuery
    ? mergeMentionSuggestions(
        skillsPickerDisabled ? [] : enabledSkills,
        mentionResult && !mentionResult.failed ? mentionResult.results : [],
        { query: mentionQuery.query, limit: MENTION_ROW_LIMIT }
      )
    : []
  // Bots to tag come first, when this composer offers any (a bot's chat).
  const botMentions = mentionQuery && mentionBots?.length ? matchTaggableBots(mentionBots, mentionQuery.query) : []
  const mentionItems: ComposerMention[] = botMentions.length
    ? [...botMentions.map((bot) => ({ kind: 'bot' as const, bot })), ...fileMentions]
    : fileMentions
  const mentionFooter = mentionResult?.failed
    ? 'File search needs a project'
    : mentionResult?.indexing
      ? 'Indexing files…'
      : mentionResult?.truncated && mentionResult.results.length > 0
        ? 'First matches only'
        : null
  // With nothing to pick and nothing to say the list stays closed, so Enter sends the text as typed.
  const showMentionPicker =
    !disabled && !suggestionsDismissed && mentionQuery !== null && (mentionItems.length > 0 || mentionFooter !== null)

  // `/` lists commands and matching skills at the start of a one-word message, and skills only after whitespace
  // mid-message. With no match the list stays closed, so Enter sends the text as typed.
  const slash = disabled || showSkillsPicker || showMentionPicker
    ? null
    : slashSuggestions(input, caret, {
        commands: slashCommands
          ? filterComposerCommandSuggestions(input).filter((command) => !skillsPickerDisabled || command.name !== 'skills')
          : [],
        skills: skillsPickerDisabled ? [] : enabledSkills,
        // A bot's composer leaves the start of the message to its own commands.
        skillsAtStart: Boolean(slashCommands)
      })
  const suggestions = slash?.items ?? []
  const slashQueryText = slash?.range ? input.slice(slash.range.index + 1, slash.range.end) : ''
  const showSuggestions = !disabled && !suggestionsDismissed && suggestions.length > 0
  const ownSuggestions = commandSuggestions && !showSuggestions && !showSkillsPicker && !showMentionPicker ? commandSuggestions(input) : NO_COMMAND_SUGGESTIONS
  const showOwnSuggestions = !disabled && !suggestionsDismissed && ownSuggestions.length > 0
  const pickerOpen = showSuggestions || showSkillsPicker || showMentionPicker || showOwnSuggestions
  const pickerItemCount = showMentionPicker
    ? mentionItems.length
    : showSkillsPicker
      ? skillSuggestions.length
      : showOwnSuggestions
        ? ownSuggestions.length
        : suggestions.length
  // `/skills` is a local UI command — never send it as a chat message.
  // While a turn is active, ordinary sends are still allowed (they stack on the per-thread queue).
  const canSend =
    (trimmedInput.length > 0 || hasAttachments) &&
    !isRecording &&
    !recordingPending &&
    !transcribing &&
    pendingReferences === 0 &&
    !disabled &&
    !sendBlocked &&
    (!connecting || sendsWhenConnected) &&
    skillsPickerQuery === null

  useEffect(() => {
    if (!pickerOpen) return
    setSelectedSuggestion((current) =>
      pickerItemCount === 0 ? 0 : Math.min(current, pickerItemCount - 1)
    )
  }, [pickerOpen, pickerItemCount])

  useEffect(() => {
    if (pickerOpen) {
      suggestionRefs.current.get(selectedSuggestion)?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedSuggestion, pickerOpen])

  // Search the project for the typed query after a short pause. The effect re-runs only when the
  // query or the scope changes; a response is kept only while it still belongs to both.
  const mentionQueryText = mentionQuery?.query
  useEffect(() => {
    setMentionSearch((current) => (current && current.scopeKey === mentionScopeKey ? current : null))
    if (mentionQueryText === undefined || !mentionScopeKey || !searchMentionsRef.current) return
    const scopeKey = mentionScopeKey
    const query = mentionQueryText
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const owned = () => !cancelled && isMentionResultCurrent({ scopeKey, query }, currentMentionRef.current)
    const run = () => {
      const request = searchMentionsRef.current
      if (!request) return
      void Promise.resolve()
        .then(() => request(query))
        .then(
          (response) => {
            if (!owned()) return
            const shownKey = `${scopeKey}\u0000${query}`
            if (shownMentionKeyRef.current !== shownKey) {
              shownMentionKeyRef.current = shownKey
              setSelectedSuggestion(0)
            }
            setMentionSearch({
              scopeKey,
              query,
              root: response.root,
              results: response.results,
              indexing: response.indexing,
              truncated: response.truncated,
              failed: false
            })
            // The first index of a large project is still building: ask again for fuller results.
            if (response.indexing) timer = setTimeout(run, MENTION_INDEXING_RETRY_MS)
          },
          () => {
            if (!owned()) return
            setMentionSearch({ scopeKey, query, root: '', results: [], indexing: false, truncated: false, failed: true })
          }
        )
    }
    timer = setTimeout(run, MENTION_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [mentionQueryText, mentionScopeKey])

  const addFiles = useCallback(
    (files: Array<File | Omit<AttachedFile, 'id'>>) => {
      if (!files.length) return
      const entries = files.map((entry) => (entry instanceof File ? { file: entry } : entry))
      const admitted = attachRules ? admitAttachments(attachedFiles, entries, { remote: attachRules.remote }) : { accepted: entries }
      if (admitted.refusal) attachRules?.onRefused(admitted.refusal)
      if (!admitted.accepted.length) return
      const next: AttachedFile[] = admitted.accepted.map((attached) => {
        return {
          ...attached,
          id: crypto.randomUUID(),
          previewUrl: attached.file.type.startsWith('image/') ? URL.createObjectURL(attached.file) : undefined
        }
      })
      onAttachedFilesChange([...attachedFiles, ...next])
      return next
    },
    [attachedFiles, onAttachedFilesChange, attachRules]
  )

  // An attachment removed while it had chips, kept so an undo that brings a chip back brings the attachment back too.
  const removedRef = useRef(new Map<string, { file: AttachedFile; at: number } | { reference: ChatReference }>())
  useEffect(() => () => {
    for (const removed of removedRef.current.values()) if ('file' in removed && removed.file.previewUrl) URL.revokeObjectURL(removed.file.previewUrl)
  }, [])

  // Removing an attachment takes its chips out of the text; `keepText` leaves the text to an undo that takes them out.
  const removeFile = (id: string, keepText = false) => {
    const at = attachedFiles.findIndex((f) => f.id === id)
    const target = attachedFiles[at]
    const key = attachmentChipKey(id)
    // With `keepText` an undo of the edit that goes with this removal may bring a chip back.
    if (target && (keepText || hasChips(key))) removedRef.current.set(key, { file: target, at })
    else if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    if (!keepText) dropChips(key)
    onAttachedFilesChange(attachedFiles.filter((f) => f.id !== id))
  }

  const removeReference = (id: string) => {
    const key = referenceChipKey(id)
    const target = references.find((reference) => reference.id === id)
    if (target && hasChips(key)) removedRef.current.set(key, { reference: target })
    dropChips(key)
    onRemoveReference(id)
  }

  const hasChips = (key: string) =>
    findAttachmentChips(composerInputRef.current?.value ?? inputValueRef.current, attachmentChipRegistry()).some((span) => span.key === key)

  // A chip back in the text (an undo) whose attachment was removed: the attachment goes back to the row.
  useEffect(() => {
    const removed = removedRef.current
    if (!removed.size) return
    const back = new Set(findAttachmentChips(input, attachmentChipRegistry()).map((span) => span.key).filter((key) => removed.has(key)))
    if (!back.size) return
    let files = attachedFiles
    for (const key of back) {
      const entry = removed.get(key)!
      removed.delete(key)
      if ('file' in entry) {
        if (files.some((f) => f.id === entry.file.id)) continue
        files = [...files.slice(0, entry.at), entry.file, ...files.slice(entry.at)]
      } else if (!references.some((reference) => reference.id === entry.reference.id)) {
        takeReference(entry.reference)
      }
    }
    if (files !== attachedFiles) onAttachedFilesChange(files)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the text changes
  }, [input])

  // Puts the text box at `next` as one edit undo can take back, replacing only the stretch that changed. Without focus
  // in the box (a chip removed from elsewhere) the text is set as it is, and focus stays where it was.
  const replaceText = (next: string) => {
    const node = composerInputRef.current
    const value = node?.value ?? inputValueRef.current
    if (next === value) return
    if (!node || document.activeElement !== node) {
      onInputChange(next)
      return
    }
    let head = 0
    while (head < value.length && value[head] === next[head]) head += 1
    let tail = 0
    while (tail < value.length - head && tail < next.length - head && value[value.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1
    editRange(node, head, value.length - tail, next.slice(head, next.length - tail))
  }

  // Takes every chip of `key` out of the text, each with the space put in beside it; `forget` also forgets them, so one
  // an undo brings back reads as its plain name.
  const dropChips = (key: string, forget = false) => {
    const value = composerInputRef.current?.value ?? inputValueRef.current
    const spans = findAttachmentChips(value, attachmentChipRegistry()).filter((span) => span.key === key)
    if (forget) unregisterAttachmentChips(key)
    if (!spans.length) return
    let next = ''
    let from = 0
    for (const span of spans) {
      let start = span.index
      let end = span.index + span.length
      const spaceBefore = start - 1 >= from && value[start - 1] === ' '
      if (value[end] === ' ' && (start === 0 || /\s/.test(value[start - 1]!))) end += 1
      else if (spaceBefore && (end === value.length || /\s/.test(value[end]!))) start -= 1
      next += value.slice(from, start)
      from = end
    }
    replaceText(next + value.slice(from))
  }

  const attachmentEntry = (attached: AttachedFile): AttachmentChipEntry => ({
    key: attachmentChipKey(attached.id),
    name: attachedFileName(attached),
    kind: attached.file.type.startsWith('image/') && !attached.pastedText ? 'image' : 'file'
  })
  const referenceEntry = (reference: ChatReference): AttachmentChipEntry => ({
    key: referenceChipKey(reference.id),
    name: reference.title,
    kind: reference.kind === 'review-comment' ? 'file' : reference.kind
  })

  // Puts chips for `entries` over `start`..`end`, as typing would, when the text has words of its own besides: in an
  // empty composer an attachment shows in the attachments row only. Returns whether they went in.
  // Returns the text with the chips in, or null where none went in.
  const placeChips = (start: number, end: number, entries: AttachmentChipEntry[]): string | null => {
    const node = composerInputRef.current
    if (!node || !entries.length || disabled) return null
    const value = node.value
    if (!hasTextAround(value, start, end)) return null
    const range = rangeOverChips(atomicChips, Math.min(start, value.length), Math.min(end, value.length))
    const insertion = chipInsertion(value, range.start, range.end, entries.map(registerAttachmentChip))
    if (document.activeElement !== node) node.focus()
    editRange(node, range.start, range.end, insertion.text)
    const caretAt = range.start + insertion.caret
    node.setSelectionRange(caretAt, caretAt)
    setCaret(caretAt)
    return value.slice(0, range.start) + insertion.text + value.slice(range.end)
  }

  // The reference already in the row for the same file, folder, thread or other target, which a chip can point at again.
  const sameReference = (reference: ChatReference): ChatReference | undefined => {
    const target = (item: ChatReference) => item.path ?? item.threadId ?? item.projectId ?? item.url ?? item.tabId
    return references.find((item) => item.kind === reference.kind && target(item) !== undefined && target(item) === target(reference))
  }

  const openAttachmentChip = (span: AttachmentChipSpan) => {
    if (span.key.startsWith('ref:')) {
      const reference = references.find((item) => referenceChipKey(item.id) === span.key)
      if (reference) openChatReference(reference)
      return
    }
    const attached = attachedFiles.find((item) => attachmentChipKey(item.id) === span.key)
    if (!attached) return
    if (attached.pastedText) {
      void previewPastedText(attached.id)
      return
    }
    // An image opens the preview its tile in the row opens.
    const tile = attachmentsRowRef.current?.querySelector<HTMLElement>(`[data-attachment-id="${CSS.escape(attached.id)}"]`)
    const open = tile?.querySelector<HTMLButtonElement>('button[aria-label^="Open"]')
    if (open) open.click()
    else if (attached.path) openFileInPanel({ path: attached.path })
  }

  const attachmentChipTitle = (span: AttachmentChipSpan): string => {
    if (span.key.startsWith('ref:')) {
      const reference = references.find((item) => referenceChipKey(item.id) === span.key)
      return reference ? referenceTitle(reference) : span.name
    }
    const attached = attachedFiles.find((item) => attachmentChipKey(item.id) === span.key)
    return attached?.path ?? (attached ? attachedFileName(attached) : span.name)
  }

  // The long paste Undo takes back while the box is as the paste left it.
  // `chip`: the paste also put its chip in the text, which the box's own undo takes out.
  const pasteUndo = useRef<{ id: string; input: string; chip: boolean } | null>(null)
  const [previewing, setPreviewing] = useState<{ id: string; name: string; text: string } | null>(null)

  /** Puts a long paste back into the box as text, where its chip is or else where the caret is, and drops its chip. */
  const insertPastedText = async (id: string) => {
    const attached = attachedFiles.find((f) => f.id === id)
    if (!attached) return
    const text = await attached.file.text()
    setPreviewing(null)
    pasteUndo.current = null
    const target = composerInputRef.current
    const chip = target && findAttachmentChips(target.value, attachmentChipRegistry()).find((span) => span.key === attachmentChipKey(id))
    if (target && chip) {
      // One edit: Undo puts the chip back, and with it the attachment.
      target.focus()
      editRange(target, chip.index, chip.index + chip.length, text)
      removeFile(id, true)
      return
    }
    removeFile(id)
    if (!target) return
    target.focus()
    // Typed in, so Undo takes it out again.
    if (document.execCommand?.('insertText', false, text)) return
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? start
    commitEdit({ value: target.value.slice(0, start) + text + target.value.slice(end), caret: start + text.length })
  }

  const previewPastedText = async (id: string) => {
    const attached = attachedFiles.find((f) => f.id === id)
    if (attached) setPreviewing({ id, name: attachedFileName(attached), text: await attached.file.text() })
  }

  const removeVoice = (id: string) => {
    const voice = voiceMessages.find((v) => v.id === id)
    if (voice) URL.revokeObjectURL(voice.url)
    onVoiceMessagesChange(voiceMessages.filter((v) => v.id !== id))
  }

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files?.length) return
    addFiles(Array.from(files))
    event.target.value = ''
  }

  const filePasteKey = useRef({ held: false, consumed: false })
  useEffect(() => {
    const reset = () => { filePasteKey.current = { held: false, consumed: false } }
    const release = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'v' || event.key === 'Control' || event.key === 'Meta') reset()
    }
    window.addEventListener('keyup', release)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keyup', release)
      window.removeEventListener('blur', reset)
    }
  }, [])

  // Pasted files (images, videos, any file) are attached; a paste without files pastes its text, unless the text is
  // long (`LONG_PASTE_BYTES`): then it goes on the message as a text file, which the chip can put back as text.
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Pasted screenshots are numbered after the message's images, never taking a name still here or kept for an undo.
    const held = [...attachedFiles, ...[...removedRef.current.values()].flatMap((entry) => ('file' in entry ? [entry.file] : []))]
    const files = collectFilesFromDataTransfer(event.clipboardData, {
      images: attachedFiles.filter((attached) => attached.file.type.startsWith('image/') && !attached.pastedText).length,
      names: held.map(attachedFileName)
    })
    const node = event.currentTarget
    if (files.length === 0) {
      // Text copied from this composer with chips in it goes back with its chips, while their attachments are here.
      const copied = event.clipboardData?.getData(COMPOSER_TEXT_MIME) ?? ''
      if (copied && findAttachmentChips(copied, attachmentChipRegistry()).length > 0) {
        event.preventDefault()
        const range = rangeOverChips(atomicChips, node.selectionStart, node.selectionEnd)
        editRange(node, range.start, range.end, copied)
        return
      }
      const text = event.clipboardData?.getData('text/plain') ?? ''
      // A thread link (Copy reference) is pasted as text, unless this chat may not point at that thread.
      const refused = pastedThreadRefusal ? threadIdsInText(text).map(pastedThreadRefusal).find(Boolean) : null
      if (refused) {
        event.preventDefault()
        onReferenceError(refused)
        return
      }
      const selected = event.currentTarget.selectionEnd - event.currentTarget.selectionStart
      if (!isLongPaste(text, messageLimit - ATTACHMENT_LINES_ROOM - (input.length - selected))) {
        // A paste replaces whole chips, never half of one; thread links in it go in as chips, in one undo step.
        const range = rangeOverChips(atomicChips, node.selectionStart, node.selectionEnd)
        const chipped = chipLinks(text)
        if (chipped.value !== text) {
          event.preventDefault()
          editRange(node, range.start, range.end, chipped.value)
        } else if (range.start !== node.selectionStart || range.end !== node.selectionEnd) {
          node.setSelectionRange(range.start, range.end)
        }
        return
      }
      event.preventDefault()
      const added = addFiles([{ file: longPasteFile(text), label: pastedTextName(text), pastedText: true }])
      if (added?.[0]) {
        const at = node.selectionEnd
        const chipped = placeChips(at, at, [attachmentEntry(added[0])])
        pasteUndo.current = { id: added[0].id, input: chipped ?? input, chip: chipped !== null }
      }
      return
    }
    event.preventDefault()
    if (filePasteKey.current.held) {
      if (filePasteKey.current.consumed) return
      filePasteKey.current.consumed = true
    }
    // Among text, each pasted file also gets its chip at the caret (a selection stays: a file never replaces words).
    const added = addFiles(files)
    if (added?.length) placeChips(node.selectionEnd, node.selectionEnd, added.map(attachmentEntry))
  }

  const applySuggestion = (command: ComposerCommandDef) => {
    if (command.name === 'skills') {
      // Keep the slash token so the skills picker opens immediately.
      onInputChange('/skills ')
      setSuggestionsDismissed(false)
      setSelectedSuggestion(0)
      requestAnimationFrame(() => composerInputRef.current?.focus())
      return
    }
    onInputChange(`/${command.name}${command.argsHint ? ' ' : ''}`)
    setSuggestionsDismissed(true)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  // A row of the parent's own list: a finished command the box already reads is sent; otherwise the box takes the row's
  // text and the list follows it (after `/model ` it offers the slots).
  const pickOwnSuggestion = (row: ComposerCommandSuggestion | undefined, run = true) => {
    if (!row) return
    if (run && row.complete && input.trim().toLowerCase() === row.fill.trim().toLowerCase()) {
      submitRef.current()
      return
    }
    setSuggestionsDismissed(false)
    setSelectedSuggestion(0)
    commitEdit({ value: row.fill, caret: row.fill.length })
  }

  // Put the text box at `edit`: new value, caret after the inserted text, focus kept.
  const commitEdit = (edit: { value: string; caret: number }) => {
    onInputChange(edit.value)
    setCaret(edit.caret, edit.value)
    requestAnimationFrame(() => {
      const target = composerInputRef.current
      if (!target) return
      target.focus()
      target.setSelectionRange(edit.caret, edit.caret)
    })
  }

  // Put `text` over `start`..`end` as typing would, so undo takes it back; without the editing command, as `commitEdit`.
  const editRange = (node: HTMLTextAreaElement, start: number, end: number, text: string) => {
    node.setSelectionRange(start, end)
    selfEditRef.current = true
    let done = false
    try {
      done = Boolean(text ? document.execCommand?.('insertText', false, text) : document.execCommand?.('delete'))
    } finally {
      selfEditRef.current = false
    }
    if (!done) commitEdit({ value: node.value.slice(0, start) + text + node.value.slice(end), caret: start + text.length })
  }

  // Text put in from outside (a draft kept across a restart) may hold chips whose attachments are gone: they read as
  // their plain names.
  useLayoutEffect(() => {
    if (input === nativeValueRef.current || !input.includes(ATTACHMENT_CHIP_HEAD)) return
    const plain = plainOrphanChips(input, attachmentChipRegistry())
    if (plain !== input) onInputChange(plain)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the text changes
  }, [input])

  // Links put in from outside the text box become chips; so does a link typing just finished, or one a drop brought.
  useLayoutEffect(() => {
    const node = composerInputRef.current
    const pending = pendingChipRef.current
    pendingChipRef.current = null
    if (!node || !hasChipLinks(input)) {
      nativeValueRef.current = input
      return
    }
    if (input !== nativeValueRef.current) {
      nativeValueRef.current = input
      const chipped = chipLinks(input)
      if (chipped.value === input) return
      const focused = document.activeElement === node
      const start = chipped.map(node.selectionStart)
      const end = chipped.map(node.selectionEnd)
      nativeValueRef.current = chipped.value
      // A prompt Up brought back is still that prompt: Escape clears it.
      if (recalledRef.current === input) recalledRef.current = chipped.value
      onInputChange(chipped.value)
      if (focused) requestAnimationFrame(() => composerInputRef.current?.setSelectionRange(start, end))
      return
    }
    if (!pending) return
    // After this commit, as an edit of its own: an editing command run while React commits would be undone by it.
    requestAnimationFrame(() => {
      const target = composerInputRef.current
      if (!target || target.selectionStart !== target.selectionEnd) return
      const value = target.value
      const chipped = chipLinks(value, pending)
      if (chipped.value === value) return
      // Only the changed stretch is replaced, as one edit undo can take back.
      let head = 0
      while (head < value.length && value[head] === chipped.value[head]) head += 1
      let tail = 0
      while (tail < value.length - head && value[value.length - 1 - tail] === chipped.value[chipped.value.length - 1 - tail]) tail += 1
      const caretAt = chipped.map(target.selectionStart)
      editRange(target, head, value.length - tail, chipped.value.slice(head, chipped.value.length - tail))
      target.setSelectionRange(caretAt, caretAt)
    })
    // Runs for a new `input` only: the helpers it calls are rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input])

  // The chip under the pointer: a thread chip (and whether the pointer is on its remove mark) or an attachment chip.
  const chipAt = (x: number, y: number): ChipHit | null => {
    const backdrop = backdropRef.current
    if (!backdrop || atomicChips.length === 0) return null
    const holds = (rect: DOMRect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    for (const element of backdrop.querySelectorAll<HTMLElement>('[data-thread-chip], [data-attachment-chip]')) {
      if (![...element.getClientRects()].some(holds)) continue
      if (element.dataset.attachmentChip !== undefined) return { kind: 'attachment', index: Number(element.dataset.attachmentChip), close: false }
      const close = element.querySelector('[data-thread-chip-close]')?.getBoundingClientRect()
      return { kind: 'thread', index: Number(element.dataset.threadChip), close: Boolean(close && holds(close)) }
    }
    return null
  }
  const onChipPointer = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    const hit = event.buttons === 0 && !disabled ? chipAt(event.clientX, event.clientY) : null
    if (hit?.kind !== chipHover?.kind || hit?.index !== chipHover?.index || hit?.close !== chipHover?.close) setChipHover(hit)
  }
  // A press on a chip opens its thread, or on its remove mark takes the chip out; it never moves the caret.
  const onChipMouseDown = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    chipPressRef.current = null
    if (event.button !== 0 || event.shiftKey || disabled) return
    const hit = chipAt(event.clientX, event.clientY)
    if (!hit) return
    event.preventDefault()
    chipPressRef.current = hit
  }
  const onChipClick = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    const pressed = chipPressRef.current
    chipPressRef.current = null
    if (!pressed) return
    const hit = chipAt(event.clientX, event.clientY)
    if (!hit || hit.kind !== pressed.kind || hit.index !== pressed.index) return
    // An attachment chip opens what it stands for: an image or pasted text in its preview, a reference where it points.
    if (hit.kind === 'attachment') {
      const span = attachmentChips[hit.index]
      if (span) openAttachmentChip(span)
      return
    }
    const chip = threadChips[hit.index]
    if (!chip) return
    if (hit?.close) {
      const node = event.currentTarget
      node.focus()
      editRange(node, chip.index, chip.index + chip.length, '')
      setChipHover(null)
    } else {
      openLinkedThread(chip.threadId)
    }
  }
  // A copied or cut selection holding chips carries their links and names; pasted back here, its attachment chips stay.
  const copyChips = (event: React.ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    if (atomicChips.length === 0) return
    const node = event.currentTarget
    const range = rangeOverChips(atomicChips, node.selectionStart, node.selectionEnd)
    const selected = node.value.slice(range.start, range.end)
    const text = expandComposerAttachmentChips(expandComposerBotChips(expandComposerThreadChips(selected)), (entry) => entry.name)
    if (text === selected) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', text)
    if (findAttachmentChips(selected, attachmentChipRegistry()).length > 0) event.clipboardData.setData(COMPOSER_TEXT_MIME, selected)
    if (cut && !disabled) editRange(node, range.start, range.end, '')
  }

  const applySkill = (skillId: string, range?: { index: number; end: number }) => {
    // Embed as an inline `@skill` token instead of switching the global chat
    // mode. The `/skills …` command becomes the token; other text is kept so
    // the skill sits between the user's typing. A picked `@query` is replaced
    // by the same token typing the full name would leave.
    const skill =
      enabledSkills.find((entry) => entry.id === skillId) ??
      enabledSkills.find((entry) => entry.name === skillId)
    const name = skill?.name ?? skillId
    const node = composerInputRef.current
    if (range) {
      commitEdit(applyMentionPick(input, range, `@${name} `))
    } else if (parseSkillsPickerQuery(input) !== null) {
      onInputChange(`@${name} `)
    } else {
      const caret = node?.selectionStart ?? input.length
      const caretEnd = node?.selectionEnd ?? caret
      const before = input.slice(0, caret)
      const after = input.slice(caretEnd)
      const sepBefore = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
      const sepAfter = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
      onInputChange(`${before}${sepBefore}@${name}${sepAfter}${after}`)
      const nextCaret = (before + sepBefore + `@${name}` + sepAfter).length
      requestAnimationFrame(() => {
        const target = composerInputRef.current
        if (!target) return
        target.focus()
        target.setSelectionRange(nextCaret, nextCaret)
      })
    }
    setSuggestionsDismissed(true)
    setSelectedSuggestion(0)
    requestAnimationFrame(() => composerInputRef.current?.focus())
  }

  // Picks a row of the `@` list. Text from an input method that is still composing is never replaced.
  const pickMention = (item: ComposerMention | undefined) => {
    if (!item || !mentionQuery || composingRef.current) return
    const range = { index: mentionQuery.index, end: Math.min(Math.max(caret, 0), input.length) }
    if (item.kind === 'skill') {
      applySkill(item.skill.id, range)
      return
    }
    // A bot leaves its chip in place of the `@query`, and a space after it unless the text goes on with one.
    if (item.kind === 'bot') {
      const gap = /^[\s.,;:!?)\]}]/.test(input.slice(range.end)) ? '' : ' '
      commitEdit(applyMentionPick(input, range, `${registerBotChip({ botId: item.bot.id, name: item.bot.name })}${gap}`))
      setSuggestionsDismissed(true)
      setSelectedSuggestion(0)
      return
    }
    if (
      !mentionScope ||
      !mentionResult ||
      mentionResult.failed ||
      !isMentionResultCurrent(mentionResult, { scopeKey: mentionScope.scopeKey, query: mentionQuery.query })
    ) return
    const picked = mentionItemReference(
      item,
      mentionResult.root,
      { threadId: mentionScope.threadId, projectId: mentionScope.projectId },
      `${item.kind}:${crypto.randomUUID()}`
    )
    // A file already in the row is pointed at again, not added twice. Among text the pick leaves its chip in place of
    // the `@query`; alone in the box it goes to the row only.
    const existing = sameReference(picked)
    const reference = existing ?? picked
    // A space after the chip, unless the text goes on with one or with punctuation.
    const gap = /^[\s.,;:!?)\]}]/.test(input.slice(range.end)) ? '' : ' '
    const chip = hasTextAround(input, range.index, range.end) ? `${registerAttachmentChip(referenceEntry(reference))}${gap}` : ''
    commitEdit(applyMentionPick(input, range, chip))
    setSuggestionsDismissed(true)
    setSelectedSuggestion(0)
    if (!existing) takeReference(reference)
  }

  // A skill picked from the `/` list becomes the same inline `@skill` token an `@` pick leaves, so it is never sent
  // as an unknown command.
  const pickSlashSkill = (skill: SkillDescriptor) => {
    if (!slash?.range || composingRef.current) return
    applySkill(skill.id, slash.range)
  }

  const submit = (options?: { steer?: boolean }) => {
    if (!canSend) return
    const skillMode: SkillChatMode | undefined = skillToken
      ? { type: 'skill', skillId: skillToken.skillId }
      : undefined
    recalledRef.current = null
    const also = tellSubagents && (tellChoice ?? options?.steer === true)
    setTellChoice(null)
    if (options?.steer || also) onSend(skillMode, { ...options, ...(also ? { alsoSubagents: true } : {}) })
    else onSend(skillMode)
  }

  // The Changes tab's "Send N comments" sends what the shown composer holds, its review comments included.
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const onRequest = () => {
      if (isShown(composerInputRef.current)) submitRef.current()
    }
    window.addEventListener(COMPOSER_SEND_EVENT, onRequest)
    return () => window.removeEventListener(COMPOSER_SEND_EVENT, onRequest)
  }, [])

  // Reply on text selected in the conversation: its pill goes in at the caret (or over the selected text).
  const quoteRef = useRef<(text: string) => void>(() => undefined)
  quoteRef.current = (text: string) => {
    const node = composerInputRef.current
    if (!node || disabled) return
    const current = node.value
    commitEdit(insertQuoteToken(current, node.selectionStart ?? current.length, node.selectionEnd ?? current.length, registerQuote(text)))
  }
  useEffect(() => {
    const onQuote = (event: Event) => {
      const detail = (event as CustomEvent<ComposerQuoteDetail>).detail
      if (detail?.target === composerInputRef.current) quoteRef.current(detail.text)
    }
    window.addEventListener(COMPOSER_QUOTE_EVENT, onQuote)
    return () => window.removeEventListener(COMPOSER_QUOTE_EVENT, onQuote)
  }, [])

  const handleInputScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    // The token backdrop paints behind the textarea: keep it scroll-locked.
    if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop
  }

  // Skill and quote tokens are painted as pills behind the text that spells them.
  const skillIndex = skillToken?.index
  const skillLength = skillToken?.length
  const inputBackdrop = useMemo(() => {
    const chip = skillIndex !== undefined && skillLength !== undefined ? { start: skillIndex, end: skillIndex + skillLength } : null
    const quotes = quoteSpans.map((span) => ({ start: span.index, end: span.index + span.length }))
    const threads = threadChips.map((span, index) => ({
      start: span.index,
      end: span.index + span.length,
      threadId: span.threadId,
      hover: chipHover?.kind === 'thread' && chipHover.index === index ? (chipHover.close ? 'close' as const : 'chip' as const) : null
    }))
    const attachments = attachmentChips.map((span, index) => ({
      start: span.index,
      end: span.index + span.length,
      kind: span.kind,
      hover: chipHover?.kind === 'attachment' && chipHover.index === index
    }))
    // A bot chip's face is the bot's look now, when this composer offers it; any other draws the default face.
    const bots = botChips.map((span) => ({
      start: span.index,
      end: span.index + span.length,
      look: mentionBots?.find((bot) => bot.id === span.botId)?.look
    }))
    return (
      <>
        {renderMarkdownBackdrop(input, chip, quotes, threads, attachments, bots)}
        {input.endsWith('\n') ? '\u200B' : null}
      </>
    )
  }, [input, skillIndex, skillLength, quoteSpans, threadChips, attachmentChips, botChips, mentionBots, chipHover])

  // Shift+Enter (or a picker-free new line) on a list item starts the next item, as the textarea's own
  // typing would: through insertText, so undo and the input event stay native.
  const continueList = (target: HTMLTextAreaElement): boolean => {
    const edit = listContinuation(target.value, target.selectionStart, target.selectionEnd)
    if (!edit) return false
    target.setSelectionRange(edit.start, edit.end)
    const inserted = edit.text
      ? document.execCommand?.('insertText', false, edit.text)
      : document.execCommand?.('delete')
    if (!inserted) {
      commitEdit({
        value: target.value.slice(0, edit.start) + edit.text + target.value.slice(edit.end),
        caret: edit.start + edit.text.length
      })
    }
    return true
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Undo right after a long paste takes its chip off, as it would take pasted text out.
    const undone = pasteUndo.current
    if (undone && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      pasteUndo.current = null
      if (e.currentTarget.value === undone.input && attachedFiles.some((f) => f.id === undone.id)) {
        // With a chip, the box's own undo takes the chip out of the text in the same step.
        if (undone.chip) {
          removeFile(undone.id, true)
          return
        }
        e.preventDefault()
        removeFile(undone.id)
        return
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      if (!e.repeat) filePasteKey.current = { held: true, consumed: false }
      if (e.repeat && filePasteKey.current.consumed) {
        e.preventDefault()
        return
      }
    }

    // An input method that is composing text owns every key: Enter commits its text, it never picks or sends.
    const keyInfo = {
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing || composingRef.current,
      keyCode: e.keyCode
    }
    if (isImeComposing(keyInfo)) return

    // One keyboard map for all three pickers: arrows, pages and Home/End move, Enter and Tab pick,
    // Escape closes. With no `@` rows Enter falls through and sends the text as typed.
    const picker = showMentionPicker ? 'mention' : showSkillsPicker ? 'skills' : showSuggestions ? 'slash' : showOwnSuggestions ? 'own' : null
    if (picker) {
      const action = pickerKeyAction(keyInfo, { count: pickerItemCount, swallowWhenEmpty: picker === 'skills' })
      if (action) {
        e.preventDefault()
        if (action.type === 'move') {
          setSelectedSuggestion((current) => moveSelection(current, action.key, pickerItemCount))
        } else if (action.type === 'dismiss') {
          setSuggestionsDismissed(true)
        } else if (action.type === 'pick') {
          if (picker === 'mention') {
            pickMention(mentionItems[selectedSuggestion])
          } else if (picker === 'skills') {
            const skill = skillSuggestions[selectedSuggestion]
            if (skill) applySkill(skill.id)
          } else if (picker === 'own') {
            // Tab only fills in; Enter also runs a finished command.
            pickOwnSuggestion(ownSuggestions[selectedSuggestion], e.key !== 'Tab')
          } else {
            const item = suggestions[selectedSuggestion]
            if (item?.kind === 'skill') {
              pickSlashSkill(item.skill)
            } else if (item) {
              const suggestion = item.command
              // An exact command that needs no text is already complete: execute it instead of
              // making users press Enter twice (first to re-apply the same suggestion).
              if (e.key === 'Enter' && suggestion.argument !== 'required' && input.trim().toLowerCase() === `/${suggestion.name}`) {
                submit()
              } else {
                applySuggestion(suggestion)
              }
            }
          }
        }
        return
      }
    }
    // A thread or attachment chip goes as one character would: Backspace after it or Delete before it removes all of it
    // (undo brings it back; an attachment stays in the row), the arrows step over it, and typing over a selection that
    // cuts into one replaces all of it.
    if (atomicChips.length > 0) {
      const node = e.currentTarget
      const { selectionStart: start, selectionEnd: end } = node
      if (start === end && (e.key === 'Backspace' || e.key === 'Delete')) {
        const chip = threadChipAtEdge(atomicChips, start, e.key)
        if (chip) {
          e.preventDefault()
          // An attachment chip goes with one of the spaces put in beside it.
          const value = node.value
          const end = chip.index + chip.length
          const spaced = 'key' in chip && value[end] === ' ' && (chip.index === 0 || /\s/.test(value[chip.index - 1]!))
          editRange(node, chip.index, spaced ? end + 1 : end, '')
          return
        }
      } else if (start === end && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const chip = e.key === 'ArrowRight'
          ? atomicChips.find((span) => span.index === start)
          : atomicChips.find((span) => span.index + span.length === start)
        if (chip) {
          e.preventDefault()
          const to = e.key === 'ArrowRight' ? chip.index + chip.length : chip.index
          node.setSelectionRange(to, to)
          setCaret(to)
          return
        }
      } else if (start !== end && (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter' || (e.key.length === 1 && !e.ctrlKey && !e.metaKey))) {
        const range = rangeOverChips(atomicChips, start, end)
        if (range.start !== start || range.end !== end) node.setSelectionRange(range.start, range.end)
      }
    }
    // A Reply pill goes as one character would: Backspace after it or Delete before it removes all of it.
    if ((e.key === 'Backspace' || e.key === 'Delete') && quoteSpans.length > 0) {
      const node = e.currentTarget
      if (node.selectionStart === node.selectionEnd) {
        const edit = deleteQuoteTokenAt(input, quoteSpans, node.selectionStart, e.key)
        if (edit) {
          e.preventDefault()
          commitEdit(edit)
          return
        }
      }
    }
    if (e.key === 'Backspace' && input.length === 0 && references.length > 0) {
      e.preventDefault()
      removeReference(references[references.length - 1].id)
      return
    }
    if (e.key === 'Backspace' && input.length === 0 && browserElements.length > 0) {
      e.preventDefault()
      onRemoveBrowserElement(browserElements[browserElements.length - 1].id)
      return
    }
    const plainKey = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
    // Up in an empty box brings back the last prompt, caret at its end.
    if (e.key === 'ArrowUp' && plainKey && input.length === 0) {
      const recalled = lastPrompt?.()
      if (recalled) {
        e.preventDefault()
        recalledRef.current = recalled
        commitEdit({ value: recalled, caret: recalled.length })
      }
      return
    }
    if (e.key === 'Escape' && recalledRef.current !== null && input === recalledRef.current) {
      e.preventDefault()
      e.stopPropagation()
      recalledRef.current = null
      onInputChange('')
      setCaret(0)
      return
    }
    if (e.key === 'Enter' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (continueList(e.currentTarget)) e.preventDefault()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // During a run Enter follows the thread's send mode and Ctrl+Enter (Cmd+Enter on macOS) does the other one;
      // Alt+Enter, the earlier steer key, still steers. With no run every Enter sends.
      // With nothing typed, the chord sends the next queued message now, as Send now on it does: also while an
      // approved command still runs (the turn can be stopped but does not count as running).
      if ((loading || stoppable) && !connecting && isSteerKey(e, platform) && trimmedInput.length === 0 && !hasAttachments && onSteerQueued?.()) {
        markSteerKey()
        return
      }
      const steer = loading && steersOnEnter(e, platform, sendMode)
      // The chord pressed again a moment later finds an empty composer: it must not answer an approval then.
      if (loading && (steer || isSteerKey(e, platform))) markSteerKey()
      submit(steer ? { steer: true } : undefined)
    }
  }

  const handleStop = () => {
    onStop?.()
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return
    if ((onAddReference && event.dataTransfer.types.includes(MOUSSE_REFERENCE_MIME)) || event.dataTransfer.types.includes('Files')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  // Adds a reference to the row; a chip placed for it before it was added goes again if it can't be added.
  const takeReference = (reference: ChatReference) => {
    if (!onAddReference) return
    setPendingReferences((count) => count + 1)
    void Promise.resolve().then(() => onAddReference(reference)).catch((error) => {
      dropChips(referenceChipKey(reference.id), true)
      onReferenceError(error instanceof Error ? error.message : String(error))
    }).finally(() => setPendingReferences((count) => count - 1))
  }

  // A reference dropped on the text gets its chip at the drop point (one already in the row is pointed at again).
  const dropReference = (reference: ChatReference, at: number | null) => {
    const existing = sameReference(reference)
    const target = existing ?? reference
    if (at !== null) placeChips(at, at, [referenceEntry(target)])
    if (!existing) takeReference(target)
  }

  // Where in the text a drop at the pointer lands, or null for a drop outside the text box.
  const dropOffset = (event: React.DragEvent): number | null => {
    const node = composerInputRef.current
    if (!node || event.target !== node) return null
    const position = document.caretPositionFromPoint?.(event.clientX, event.clientY)
    const at = position && position.offsetNode === node
      ? Math.min(position.offset, node.value.length)
      : backdropOffsetAt(event.clientX, event.clientY) ?? node.selectionEnd
    return wordEdge(node.value, at)
  }

  // The text offset under a point, read from the backdrop, which draws the box's text glyph for glyph.
  const backdropOffsetAt = (x: number, y: number): number | null => {
    const backdrop = backdropRef.current
    if (!backdrop || typeof document.caretRangeFromPoint !== 'function') return null
    const node = composerInputRef.current
    const previous = { backdrop: backdrop.style.pointerEvents, input: node?.style.pointerEvents ?? '' }
    backdrop.style.pointerEvents = 'auto'
    if (node) node.style.pointerEvents = 'none'
    let range: Range | null = null
    try {
      range = document.caretRangeFromPoint(x, y)
    } finally {
      backdrop.style.pointerEvents = previous.backdrop
      if (node) node.style.pointerEvents = previous.input
    }
    if (!range || !backdrop.contains(range.startContainer)) return null
    let offset = 0
    const walker = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT)
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (text === range.startContainer) return Math.min(offset + range.startOffset, inputValueRef.current.length)
      offset += text.textContent?.length ?? 0
    }
    return null
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return
    const at = dropOffset(event)
    const reference = onAddReference ? parseReferenceDragData(event.dataTransfer) : null
    if (reference && onAddReference) {
      event.preventDefault()
      event.stopPropagation()
      dropReference(reference, at)
      return
    }
    const files = Array.from(event.dataTransfer.files)
    if (!files.length) return
    event.preventDefault()
    // A file this window drags out (a file tree row, a chip) means here what the window's own drag meant.
    const own = ownFileDrop(files)
    if (own?.kind === 'ignore') return
    if (own?.kind === 'reference') {
      const parsed = parseChatReference({ ...own.reference, id: own.reference.id ?? `${own.reference.kind}:${crypto.randomUUID()}` })
      if (parsed && onAddReference) dropReference(parsed, at)
      return
    }
    // Dropped on the text among words, each file also gets its chip at the drop point.
    const added = addFiles(files)
    if (added?.length && at !== null) placeChips(at, at, added.map(attachmentEntry))
  }

  return (
    <div data-mousse="composer" className="composer" onDragOver={handleDragOver} onDrop={handleDrop}>
      <ConnectingDots shown={connecting} instant={handover} />
      {banner}
      {previewing && (
        <PastedTextPreview
          name={previewing.name}
          text={previewing.text}
          onClose={() => setPreviewing(null)}
          onInsert={() => void insertPastedText(previewing.id)}
        />
      )}
      {hasAttachments && (
        <div className="composer-attachments">
          <div ref={attachmentsRowRef} className="composer-attachments-scroll">
            {/* An attached image opens a preview that steps through the other attached images. */}
            <ImageGalleryProvider images={() => attachedFiles.flatMap(({ id, file, previewUrl }) => (previewUrl && !attachmentStatus?.get(id)?.noPreview ? [{ id, url: previewUrl, filename: file.name }] : []))}>
              {attachedFiles.map((attached) => {
                const { id, file, path, pastedText } = attached
                // An image that can't be read here shows as a file chip, not a broken thumbnail.
                const previewUrl = attachmentStatus?.get(id)?.noPreview ? undefined : attached.previewUrl
                return (
                  <FileAttachment
                    key={id}
                    id={id}
                    // Beside image thumbnails a file is a tile of the same size, so the row reads as one.
                    display={previewUrl === undefined && rowHasImages ? 'tile' : 'chip'}
                    filename={attachedFileName(attached)}
                    size={path ? undefined : file.size}
                    title={pastedText ? 'Sent to the agent as a text file. Click to view.' : path}
                    isImage={previewUrl !== undefined}
                    url={previewUrl}
                    onOpen={pastedText ? () => void previewPastedText(id) : undefined}
                    onInsertText={pastedText ? () => void insertPastedText(id) : undefined}
                    className={pastedText ? 'max-w-[280px]' : undefined}
                    status={attachmentStatus?.get(id)}
                    onRemove={() => removeFile(id)}
                    onDragStart={(event) => startDragOut(event, {
                      name: file.name,
                      threadId: mentionScope?.threadId,
                      projectId: mentionScope?.projectId,
                      ...(path ? { item: { kind: 'attachment' as const, path, name: file.name } } : { composerFile: file }),
                      // Dropped back on the composer, it is already attached.
                      inApp: { kind: 'ignore' }
                    })}
                  />
                )
              })}
            </ImageGalleryProvider>
            {references.map((reference) => (
              <ChatReferencePill key={reference.id} reference={reference} tile={rowHasImages} onRemove={() => removeReference(reference.id)} />
            ))}
            {browserElements.map((element) => (
              <BrowserElementPill
                key={element.id}
                element={element}
                onRemove={() => onRemoveBrowserElement(element.id)}
              />
            ))}
            {voiceMessages.map(({ id, duration }) => (
              <div key={id} className="composer-attachment-pill composer-attachment-pill-voice">
                <Mic size={12} strokeWidth={2} />
                <span>Voice {formatDuration(duration)}</span>
                <button
                  type="button"
                  className="composer-attachment-remove"
                  onClick={() => removeVoice(id)}
                  aria-label="Remove voice message"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="composer-input-wrap">
        <div ref={backdropRef} className="composer-input-backdrop" aria-hidden="true">
          {inputBackdrop}
        </div>
        <textarea
          ref={composerInputRef}
          className={`composer-input composer-input-mirrored${chipHover ? ' composer-input-on-chip' : ''}`}
          value={input}
          // On an attachment chip the pointer shows where its file is.
          title={chipHover?.kind === 'attachment' && attachmentChips[chipHover.index] ? attachmentChipTitle(attachmentChips[chipHover.index]!) : undefined}
          onChange={(e) => {
            setSuggestionsDismissed(false)
            setSelectedSuggestion(0)
            setCaret(readCaret(e.target), e.target.value)
            nativeValueRef.current = e.target.value
            // A space or new line typed after a thread link, or a drop, may make a chip (see the effect above).
            const typed = e.nativeEvent as InputEvent
            if (!selfEditRef.current) {
              const at = e.target.selectionStart - (typed.data?.length ?? 1)
              if (typed.inputType === 'insertFromDrop') pendingChipRef.current = { start: 0, end: e.target.value.length }
              else if (typed.inputType === 'insertLineBreak' || (typed.inputType === 'insertText' && typed.data && /^\s+$/.test(typed.data)))
                pendingChipRef.current = { start: at, end: at }
            }
            onInputChange(e.target.value)
          }}
          onMouseMove={onChipPointer}
          onMouseLeave={() => setChipHover(null)}
          onMouseDown={onChipMouseDown}
          onClick={onChipClick}
          onCopy={(e) => copyChips(e, false)}
          onCut={(e) => copyChips(e, true)}
          onSelect={(e) => {
            // The caret never rests inside a Reply pill, so typing can't split one.
            const node = e.currentTarget
            const inside = node.selectionStart === node.selectionEnd
              ? quoteTokenAround(quoteSpans, node.selectionStart) ?? threadChipAround(atomicChips, node.selectionStart)
              : undefined
            if (inside) {
              const end = inside.index + inside.length
              const next = node.selectionStart - inside.index < end - node.selectionStart ? inside.index : end
              node.setSelectionRange(next, next)
            }
            setCaret(readCaret(node))
          }}
          onKeyUp={(e) => setCaret(readCaret(e.currentTarget))}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={(e) => {
            composingRef.current = false
            setCaret(readCaret(e.currentTarget))
          }}
          onKeyDown={handleKeyDown}
          onScroll={handleInputScroll}
          onPaste={handlePaste}
          onFocus={resizeDraft}
          placeholder={
            connecting ? CONNECTING_TEXT : placeholder ?? (loading
              ? sendMode === 'steer'
                ? `Steer the reply · ${formatBinding(STEER_BINDING, platform)} queues`
                : `Queue a follow-up · ${formatBinding(STEER_BINDING, platform)} steers`
              : 'Ask anything · / commands and skills · @ files')
          }
          rows={3}
          disabled={disabled}
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? 'composer-command-suggestions' : undefined}
          aria-activedescendant={
            pickerOpen && pickerItemCount > 0
              ? `composer-command-suggestion-${selectedSuggestion}`
              : undefined
          }
        />
      </div>

      {showMentionPicker && (
        <ComposerSuggestionList
          ariaLabel={botMentions.length && !fileMentions.length ? 'Bots to tag' : 'File, folder and skill suggestions'}
          rows={mentionItems.map(
            (item): SuggestionRow => item.kind === 'bot'
              ? { key: `bot:${item.bot.id}`, content: <BotMentionRow bot={item.bot} query={mentionQuery?.query} /> }
              : {
                  key: item.kind === 'skill' ? `skill:${item.skill.id}` : `${item.kind}:${item.path}`,
                  content: <MentionRowContent item={item} query={mentionQuery?.query} />
                }
          )}
          selected={selectedSuggestion}
          onHover={setSelectedSuggestion}
          onPick={(index) => pickMention(mentionItems[index])}
          footer={mentionFooter}
          registerRow={registerSuggestionRow}
        />
      )}

      {showSkillsPicker && (
        <ComposerSuggestionList
          ariaLabel="Skill suggestions"
          rows={skillSuggestions.map(
            (skill): SuggestionRow => ({
              key: skill.id,
              content: <SkillRowContent skill={skill} query={skillsPickerQuery ?? ''} />
            })
          )}
          selected={selectedSuggestion}
          onHover={setSelectedSuggestion}
          onPick={(index) => {
            const skill = skillSuggestions[index]
            if (skill) applySkill(skill.id)
          }}
          emptyText={
            enabledSkills.length === 0
              ? <>No skills · <button type="button" className="composer-command-suggestion-empty-link" onClick={() => openSettingsSection('integrations')}>Settings</button></>
              : 'No skills match that filter.'
          }
          registerRow={registerSuggestionRow}
        />
      )}

      {showSuggestions && (
        <ComposerSuggestionList
          ariaLabel={slash?.midMessage ? 'Skill suggestions' : 'Slash command suggestions'}
          rows={suggestions.map(
            (item): SuggestionRow =>
              item.kind === 'skill'
                ? { key: `skill:${item.skill.id}`, content: <SkillRowContent skill={item.skill} query={slashQueryText} /> }
                : {
                    key: item.command.name,
                    content: (
                      <CommandRowContent
                        label={`/${item.command.name}${item.command.argsHint ? ` ${item.command.argsHint}` : ''}`}
                        description={item.command.description}
                        query={slashQueryText ? `/${slashQueryText}` : ''}
                      />
                    )
                  }
          )}
          selected={selectedSuggestion}
          onHover={setSelectedSuggestion}
          onPick={(index) => {
            const item = suggestions[index]
            if (item?.kind === 'skill') pickSlashSkill(item.skill)
            else if (item) applySuggestion(item.command)
          }}
          footer={slash?.midMessage ? 'Skills only mid-message' : undefined}
          registerRow={registerSuggestionRow}
        />
      )}

      {showOwnSuggestions && (
        <ComposerSuggestionList
          ariaLabel="Command suggestions"
          rows={ownSuggestions.map(
            (row): SuggestionRow => ({
              key: row.key,
              content: <CommandRowContent label={row.label} description={row.description} />
            })
          )}
          selected={selectedSuggestion}
          onHover={setSelectedSuggestion}
          onPick={(index) => pickOwnSuggestion(ownSuggestions[index])}
          registerRow={registerSuggestionRow}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="*/*"
        className="composer-file-input"
        onChange={handleFileSelect}
        aria-hidden="true"
        tabIndex={-1}
      />

      <ComposerFooter
        run={run}
        onAttachClick={() => fileInputRef.current?.click()}
        loading={loading}
        stoppable={stoppable}
        disabled={disabled}
        canSend={canSend}
        sendBlocked={sendBlocked}
        isRecording={isRecording}
        recordingPending={recordingPending}
        transcribing={transcribing}
        onSend={() => submit(sendMode === 'steer' ? { steer: true } : undefined)}
        sendLabel={sendLabel}
        onStop={handleStop}
        onStartRecording={startDictation}
        onStopRecording={dictation.stop}
        onCancelRecording={dictation.cancel}
        recordingDuration={recordingDuration}
        recordingLevels={dictation.levels}
        allowAttachWhileLoading
        permission={permission}
        extraActions={tellSubagents ? (
          <>
            {extraActions}
            <button
              type="button"
              className={`composer-icon-btn composer-tell-subagents-btn${tellOn ? ' is-on' : ''}`}
              title={tellOn ? 'Also tell subagents: on' : 'Also tell subagents: off'}
              aria-label="Also tell subagents"
              aria-pressed={tellOn}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setTellChoice(!tellOn)}
              disabled={disabled}
            >
              <GitFork size={16} strokeWidth={2} />
            </button>
          </>
        ) : extraActions}
        connecting={connecting}
        connectingNote={connecting && (input.length > 0 || hasAttachments) ? CONNECTING_TEXT : null}
        {...(sendModeShown ? { sendMode: { mode: sendMode, onSwitch: switchSendMode } } : {})}
      />
    </div>
  )
}

export function formatVoiceDuration(seconds: number): string {
  return formatDuration(seconds)
}

/**
 * The message a send carries. Images travel as separate vision payloads; every other file is listed with its path
 * (`filePaths`, by attached id, from `composerFilePaths`) so the model can read it. Without a path (a draft measured
 * before sending) a file is listed by name.
 */
export function buildComposerMessageContent(
  input: string,
  attachedFiles: AttachedFile[],
  voiceMessages: VoiceMessage[],
  browserElements: BrowserElementAttachment[] = [],
  references: ChatReference[] = [],
  filePaths: ReadonlyMap<string, string> = new Map(),
  pastedTexts: ReadonlyArray<{ name: string; text: string }> = []
): string {
  const parts: string[] = []
  const typed = expandComposerAttachmentChips(
    expandComposerBotChips(expandComposerThreadChips(expandComposerQuotes(input))),
    (entry) => sentChipText(entry, attachedFiles, references)
  ).trim()
  if (typed) parts.push(typed)
  for (const pasted of pastedTexts) parts.push(pastedTextBlock(pasted.name, pasted.text))

  const files = fileAttachments(attachedFiles).map((attached) => ({ name: attachedFileName(attached), path: filePaths.get(attached.id) ?? attached.path }))
  if (files.length) parts.push(formatAttachedFilesMarker(files))

  if (voiceMessages.length) {
    const voiceList = voiceMessages
      .map((v) => `Voice message (${formatDuration(v.duration)})`)
      .join(', ')
    parts.push(`[${voiceList}]`)
  }

  if (browserElements.length) {
    parts.push(browserElements.map((element) => formatBrowserElementBlock(element)).join('\n\n'))
  }

  if (references.length) parts.push(formatChatReferences(references))

  return parts.join('\n\n')
}

/**
 * What an attachment chip says in the sent text (`shared/inlineAttachments.ts`): an image the agent gets inline with its
 * place among the message's images, a file sent as a path by its name in the files marker, a reference by its kind and
 * title. A chip whose attachment is not among these says what it was.
 */
function sentChipText(entry: AttachmentChipEntry, attachedFiles: readonly AttachedFile[], references: readonly ChatReference[]): string {
  if (entry.key.startsWith('ref:')) {
    const reference = references.find((item) => referenceChipKey(item.id) === entry.key)
    if (reference?.kind === 'review-comment') return reference.title
    if (reference) return formatSentChip({ kind: reference.kind, name: reference.title })
    return formatSentChip({ kind: entry.kind, name: entry.name })
  }
  const attached = attachedFiles.find((item) => attachmentChipKey(item.id) === entry.key)
  if (!attached) return formatSentChip({ kind: entry.kind, name: entry.name })
  const asPath = new Set(fileAttachments(attachedFiles))
  if (asPath.has(attached)) return formatSentChip({ kind: 'file', name: attachedFileName(attached) })
  const images = attachedFiles.filter((item) => !asPath.has(item))
  return formatSentChip({ kind: 'image', name: attachedFileName(attached), image: images.indexOf(attached) + 1 })
}

const MARKDOWN_CLASS: Record<MarkdownKind, string> = {
  marker: 'composer-md-marker',
  bold: 'composer-md-bold',
  italic: 'composer-md-italic',
  strike: 'composer-md-strike',
  code: 'composer-md-code',
  codeblock: 'composer-md-codeblock',
  heading: 'composer-md-heading',
  quote: 'composer-md-quote',
  list: 'composer-md-list',
  link: 'composer-md-link'
}

/**
 * The draft as the backdrop paints it: Markdown spans, with the inline `@skill` token's pill on top.
 * Every character stays the width the textarea gives it, so the caret sits on the painted text.
 */
function renderMarkdownBackdrop(
  text: string,
  chip: { start: number; end: number } | null,
  quotes: Array<{ start: number; end: number }> = [],
  threads: Array<{ start: number; end: number; threadId: string; hover: 'chip' | 'close' | null }> = [],
  attachments: Array<{ start: number; end: number; kind: AttachmentChipEntry['kind']; hover: boolean }> = [],
  bots: Array<{ start: number; end: number; look?: BotLook }> = []
): ReactNode[] {
  const cuts = [...(chip ? [chip.start, chip.end] : []), ...[...quotes, ...threads, ...attachments, ...bots].flatMap((token) => [token.start, token.end])]
  const nodes: ReactNode[] = []
  for (const span of composerMarkdownSpans(text)) {
    const bounds = [...new Set([span.start, ...cuts.filter((cut) => cut > span.start && cut < span.end), span.end])].sort((a, b) => a - b)
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const start = bounds[i]
      const end = bounds[i + 1]
      // A bot chip is drawn whole: the bot's face in the token's blank slot, then its name, in its colour.
      const bot = bots.find((item) => start >= item.start && end <= item.end)
      if (bot) {
        if (start === bot.start) nodes.push(<ComposerBotChip key={start} token={text.slice(bot.start, bot.end)} look={bot.look} />)
        continue
      }
      // A Reply pill is drawn whole, without Markdown: its reply icon in the token's blank first slot, then the preview.
      // A thread chip is drawn whole too: its icon and status dot in the token's blank slots.
      const threadIndex = threads.findIndex((item) => start >= item.start && end <= item.end)
      if (threadIndex >= 0) {
        const thread = threads[threadIndex]
        if (start === thread.start) {
          nodes.push(<ComposerThreadChip key={start} index={threadIndex} token={text.slice(thread.start, thread.end)} threadId={thread.threadId} hover={thread.hover} />)
        }
        continue
      }
      // An attachment chip is drawn whole: its icon in the token's blank slot, then its name.
      const attachmentIndex = attachments.findIndex((item) => start >= item.start && end <= item.end)
      if (attachmentIndex >= 0) {
        const attachment = attachments[attachmentIndex]
        if (start === attachment.start) {
          nodes.push(<ComposerAttachmentChip key={start} index={attachmentIndex} token={text.slice(attachment.start, attachment.end)} kind={attachment.kind} hover={attachment.hover} />)
        }
        continue
      }
      const quote = quotes.find((item) => start >= item.start && end <= item.end)
      if (quote) {
        if (start === quote.start) {
          const token = text.slice(quote.start, quote.end)
          nodes.push(
            <span key={start} className="composer-token-chip composer-quote-chip">
              <span className="composer-quote-tag">{token.slice(0, QUOTE_TAG_LENGTH)}<Reply size={13} strokeWidth={2.2} className="composer-quote-icon" aria-hidden /></span>
              {token.slice(QUOTE_TAG_LENGTH)}
            </span>
          )
        }
        continue
      }
      const classes = span.kinds.map((kind) => MARKDOWN_CLASS[kind])
      if (chip && start >= chip.start && end <= chip.end) classes.push('composer-token-chip')
      const piece = text.slice(start, end)
      nodes.push(classes.length ? <span key={start} className={classes.join(' ')}>{piece}</span> : piece)
    }
  }
  return nodes
}

/** A bot chip as the input backdrop draws it, over the token's own glyphs: the bot's face in its blank slot, then its name. */
function ComposerBotChip({ token, look }: { token: string; look?: BotLook }) {
  const parts = botChipParts(token)
  const shown = look ?? DEFAULT_BOT_LOOK
  return (
    <span className="composer-thread-chip composer-bot-chip" style={{ '--tag-colour': BOT_COLOUR_HEX[normalizeBotLook(shown).colour] } as CSSProperties}>
      <span className="composer-chip-slot">{parts.head}<span className="composer-bot-chip-face"><BotFace look={shown} state="idle" size={14} view="head" still /></span></span>
      {parts.rest}
    </span>
  )
}

/** A bot in the `@` list: its face, its name with the typed part marked, and what it does. */
function BotMentionRow({ bot, query = '' }: { bot: TaggableBot; query?: string }) {
  return (
    <span className="composer-suggestion-row">
      <span className="composer-suggestion-icon composer-suggestion-bot" aria-hidden="true">
        <BotFace look={bot.look} state="idle" size={18} view="head" still />
      </span>
      <span className="composer-suggestion-text">
        <span className="composer-command-suggestion-name"><MarkedText segments={markQuery(bot.name, query)} /></span>
        {bot.description ? <span className="composer-command-suggestion-description">{bot.description}</span> : null}
      </span>
    </span>
  )
}

/** An attachment chip as the input backdrop draws it, over the token's own glyphs: the icon in its blank slot, then the name. */
function ComposerAttachmentChip({ index, token, kind, hover }: { index: number; token: string; kind: AttachmentChipEntry['kind']; hover: boolean }) {
  const parts = attachmentChipParts(token)
  const Icon = kind === 'image' ? IconPhoto : kind === 'file' ? FileIcon : REFERENCE_ICONS[kind]
  return (
    <span className="composer-thread-chip composer-attachment-chip" data-attachment-chip={index} {...(hover ? { 'data-hover': 'chip' } : {})}>
      <span className="composer-chip-slot">{parts.head}<Icon size={12} strokeWidth={2} className="composer-thread-chip-icon" aria-hidden /></span>
      {parts.rest}
    </span>
  )
}

/**
 * A thread chip as the input backdrop draws it, over the token's own glyphs: the icon in the first blank slot, the
 * title (and the computer for another computer's thread), and the thread's status dot in the last slot, which shows the
 * remove mark while the pointer is on the chip.
 */
function ComposerThreadChip({ index, token, threadId, hover }: { index: number; token: string; threadId: string; hover: 'chip' | 'close' | null }) {
  const thread = useAppStore((state) => state.threads.find((entry) => entry.id === threadId))
  const activity = useAppStore((state) => state.threadActivity[threadId])
  const lastPhase = useAppStore((state) => state.turnStates[threadId]?.phase)
  const status = thread ? threadLinkStatus(activity, lastPhase, false, thread.setupFailure !== undefined, thread.lastRun) : 'missing'
  const parts = threadChipParts(token)
  return (
    <span
      className="composer-thread-chip"
      data-thread-chip={index}
      data-status={status}
      {...(thread?.archivedAt !== undefined ? { 'data-archived': '' } : {})}
      {...(hover ? { 'data-hover': hover } : {})}
    >
      <span className="composer-chip-slot">{parts.head}<MessageSquare size={12} strokeWidth={2} className="composer-thread-chip-icon" aria-hidden /></span>
      {parts.title}
      {parts.computer && <span className="composer-thread-chip-computer">{parts.computer}</span>}
      {parts.gap}
      <span className="composer-chip-slot" data-thread-chip-close="">
        {parts.dot}
        {hover ? <X size={11} strokeWidth={2.4} className="composer-thread-chip-remove" aria-hidden /> : <span className="composer-thread-chip-dot" />}
      </span>
      {parts.tail}
    </span>
  )
}
