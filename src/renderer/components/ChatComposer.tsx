import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Loader2, Mic, RefreshCw, X } from '../lib/icons'
import { SpeechWave } from '../speech/SpeechWave'
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
  isImeComposing,
  isMentionResultCurrent,
  mentionItemReference,
  mergeMentionSuggestions,
  moveSelection,
  parseSkillsPickerQuery,
  pickerKeyAction,
  removeInlineSkillToken,
  type ComposerCommandDef,
  type MentionItem
} from '../../shared/composerCommands'
import { ComposerSuggestionList, MentionRowContent, type SuggestionRow } from './ComposerSuggestionList'
import { ComposerFooter, STEER_BINDING, isSteerKey, type ComposerRunProps } from './ComposerFooter'
import { markSteerKey, steersOnEnter, type SendMode } from '../lib/steerKey'
import { useThreadSendMode } from '../lib/sendMode'
import { BrowserElementPill } from './BrowserElementPill'
import { FileAttachment } from '../chat/components/agent-elements/input/file-attachment'
import { ImageGalleryProvider } from '../chat/components/agent-elements/image-gallery'
import { formatBrowserElementBlock } from '../utils/messageAttachments'
import { collectImageFilesFromDataTransfer } from '../utils/imageAttachments'
import type { ChatReference } from '../../shared/chatReferences'
import { formatChatReferences, MOUSSE_REFERENCE_MIME, parseReferenceDragData } from '../../shared/chatReferences'
import { ChatReferencePill } from './ReferencePill'
import { insertTranscript } from '../dictation/insertTranscript'
import { useDictation } from '../dictation/useDictation'
import { useCommand } from '../commands/commandRegistry'
import { formatBinding } from '../../shared/commands'
import { useAppStore } from '../stores/appStore'
import { openSettingsSection } from '../lib/settingsNavigation'
import { COMPOSER_SEND_EVENT } from '../lib/composerEvents'
import { useComposerNotice } from './ComposerNotice'
import { composerMarkdownSpans, listContinuation, type MarkdownKind } from '../lib/composerMarkdown'

export interface AttachedFile {
  id: string
  file: File
  previewUrl?: string
}

export interface VoiceMessage {
  id: string
  blob: Blob
  duration: number
  url: string
}

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
  enabledSkills: SkillDescriptor[]
  /**
   * The model picker and context ring (see `ComposerFooter`). A thread's composer has them; a bot's
   * has none, as a bot picks its own model.
   */
  run?: ComposerRunProps
  /** `/` commands (`/clear`, `/compact`, …) are offered while typing; a bot's composer has none. */
  slashCommands?: boolean
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
  onSend: (skillMode?: SkillChatMode, options?: { steer?: boolean }) => void
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
  /** Searches the project's files and folders for an `@` mention; rejects when there is no project to search. */
  searchMentions?: (query: string) => Promise<FileSearchResponse>
  /**
   * Which thread and project `searchMentions` answers for. Results from another scope are
   * dropped, and picked files get this thread and project on their reference.
   */
  mentionScope?: { scopeKey: string; threadId?: string; projectId?: string }
  /** The thread's permission mode and how to change it (see `ComposerFooter`). */
  permission?: ComponentProps<typeof ComposerFooter>['permission']
  /** Dictation stays offered while a run can be stopped (see `ComposerFooter`): a bot's chat. */
  dictateWhileStoppable?: boolean
  /** Buttons of the caller's own in the footer, left of Attach (see `ComposerFooter`). */
  extraActions?: ReactNode
  /**
   * The thread whose send mode (Queue or Steer, `lib/sendMode.ts`) Enter follows while a reply runs; the mode
   * button left of send shows and switches it. Absent (a bot's chat, which never steers): Enter queues and there is
   * no button.
   */
  sendModeThreadId?: string
}

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
/** A kept-mounted pane that is not the one in view is inert; its composer must not answer shortcuts. */
function isShown(input: HTMLElement | null): boolean {
  return !input?.closest('[inert]')
}

function readCaret(node: HTMLTextAreaElement): number {
  return node.selectionStart === node.selectionEnd ? node.selectionStart : -1
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
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
  enabledSkills,
  run,
  slashCommands = true,
  loading = false,
  stoppable = loading,
  disabled = false,
  placeholder,
  onSend,
  onSteerQueued,
  sendLabel,
  onStop,
  lastPrompt,
  disableSkillsPicker = false,
  banner,
  searchMentions,
  mentionScope,
  permission,
  sendModeThreadId,
  dictateWhileStoppable = false,
  extraActions
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  // The send mode is a choice only while a reply runs: idle, Enter just sends. A card that takes the message (an open
  // question, a waiting approval: `sendLabel`) keeps Enter for itself.
  const [threadSendMode, setThreadSendMode] = useThreadSendMode(sendModeThreadId)
  const sendModeShown = Boolean(sendModeThreadId) && loading && !sendLabel
  const sendMode: SendMode = sendModeShown ? threadSendMode : 'queue'
  const switchSendMode = () => setThreadSendMode(sendMode === 'steer' ? 'queue' : 'steer')
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
    // The backdrop paints the visible text: it wraps at the textarea's width, scrollbar excluded,
    // and follows its scroll.
    const backdrop = backdropRef.current
    if (backdrop) {
      backdrop.style.marginRight = `${inputElement.offsetWidth - inputElement.clientWidth}px`
      backdrop.scrollTop = inputElement.scrollTop
    }
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
  const [caret, setCaret] = useState(0)
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
  const dictation = useDictation({ disabled, loading, onTranscript: insertDictation })
  const { isRecording, recordingPending, transcribing, recordingDuration } = dictation
  const startDictation = () => {
    const node = composerInputRef.current
    dictationRangeRef.current = node ? { start: node.selectionStart, end: node.selectionEnd, value: node.value } : null
    dictation.start()
  }
  const [pendingReferences, setPendingReferences] = useState(0)
  // Dictation and reference progress share the composer's one notice line, so the composer never changes height.
  useComposerNotice(pendingReferences > 0 ? { tone: 'info', title: 'Attaching reference…' } : null)
  useComposerNotice(recordingPending ? { tone: 'info', title: 'Requesting microphone access…' } : null)
  useComposerNotice(dictation.notice ? { tone: 'info', title: dictation.notice } : null)
  useComposerNotice(dictation.error ? {
    tone: 'error',
    title: dictation.error.message,
    actions: [{ label: 'Retry microphone', icon: <RefreshCw size={14} strokeWidth={1.8} />, disabled: loading || disabled || recordingPending || transcribing, onClick: startDictation }],
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

  const hasAttachments = attachedFiles.length > 0 || voiceMessages.length > 0 || browserElements.length > 0 || references.length > 0
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
  const mentionItems: MentionItem<SkillDescriptor>[] = mentionQuery
    ? mergeMentionSuggestions(
        skillsPickerDisabled ? [] : enabledSkills,
        mentionResult && !mentionResult.failed ? mentionResult.results : [],
        { query: mentionQuery.query, limit: MENTION_ROW_LIMIT }
      )
    : []
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

  const suggestions = !slashCommands || showSkillsPicker || showMentionPicker ? [] : filterComposerCommandSuggestions(input).filter((command) => !skillsPickerDisabled || command.name !== 'skills')
  const showSuggestions = !disabled && !suggestionsDismissed && suggestions.length > 0
  const pickerOpen = showSuggestions || showSkillsPicker || showMentionPicker
  const pickerItemCount = showMentionPicker
    ? mentionItems.length
    : showSkillsPicker
      ? skillSuggestions.length
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
    (files: File[]) => {
      if (!files.length) return
      const next: AttachedFile[] = files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
      }))
      onAttachedFilesChange([...attachedFiles, ...next])
    },
    [attachedFiles, onAttachedFilesChange]
  )

  const removeFile = (id: string) => {
    const target = attachedFiles.find((f) => f.id === id)
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    onAttachedFilesChange(attachedFiles.filter((f) => f.id !== id))
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

  const imagePasteKey = useRef({ held: false, consumed: false })
  useEffect(() => {
    const reset = () => { imagePasteKey.current = { held: false, consumed: false } }
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

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = collectImageFilesFromDataTransfer(event.clipboardData)
    if (images.length === 0) return
    event.preventDefault()
    if (imagePasteKey.current.held) {
      if (imagePasteKey.current.consumed) return
      imagePasteKey.current.consumed = true
    }
    addFiles(images)
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

  // Put the text box at `edit`: new value, caret after the inserted text, focus kept.
  const commitEdit = (edit: { value: string; caret: number }) => {
    onInputChange(edit.value)
    setCaret(edit.caret)
    requestAnimationFrame(() => {
      const target = composerInputRef.current
      if (!target) return
      target.focus()
      target.setSelectionRange(edit.caret, edit.caret)
    })
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
  const pickMention = (item: MentionItem<SkillDescriptor> | undefined) => {
    if (!item || !mentionQuery || composingRef.current) return
    const range = { index: mentionQuery.index, end: Math.min(Math.max(caret, 0), input.length) }
    if (item.kind === 'skill') {
      applySkill(item.skill.id, range)
      return
    }
    if (
      !mentionScope ||
      !mentionResult ||
      mentionResult.failed ||
      !isMentionResultCurrent(mentionResult, { scopeKey: mentionScope.scopeKey, query: mentionQuery.query })
    ) return
    const reference = mentionItemReference(
      item,
      mentionResult.root,
      { threadId: mentionScope.threadId, projectId: mentionScope.projectId },
      `${item.kind}:${crypto.randomUUID()}`
    )
    commitEdit(applyMentionPick(input, range, ''))
    setSuggestionsDismissed(true)
    setSelectedSuggestion(0)
    setPendingReferences((count) => count + 1)
    void Promise.resolve().then(() => onAddReference?.(reference)).catch((error) => {
      onReferenceError(error instanceof Error ? error.message : String(error))
    }).finally(() => setPendingReferences((count) => count - 1))
  }

  const submit = (options?: { steer?: boolean }) => {
    if (!canSend) return
    const skillMode: SkillChatMode | undefined = skillToken
      ? { type: 'skill', skillId: skillToken.skillId }
      : undefined
    recalledRef.current = null
    if (options?.steer) onSend(skillMode, options)
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

  const handleInputScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    // The token backdrop paints behind the textarea: keep it scroll-locked.
    if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop
  }

  const renderInputBackdrop = () => {
    const chip = skillToken ? { start: skillToken.index, end: skillToken.index + skillToken.length } : null
    return (
      <>
        {renderMarkdownBackdrop(input, chip)}
        {input.endsWith('\n') ? '\u200B' : null}
      </>
    )
  }

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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      if (!e.repeat) imagePasteKey.current = { held: true, consumed: false }
      if (e.repeat && imagePasteKey.current.consumed) {
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
    const picker = showMentionPicker ? 'mention' : showSkillsPicker ? 'skills' : showSuggestions ? 'slash' : null
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
          } else {
            const suggestion = suggestions[selectedSuggestion]
            if (suggestion) {
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
    if (e.key === 'Backspace' && input.length === 0 && references.length > 0) {
      e.preventDefault()
      onRemoveReference(references[references.length - 1].id)
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
      if ((loading || stoppable) && isSteerKey(e, platform) && trimmedInput.length === 0 && !hasAttachments && onSteerQueued?.()) {
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

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return
    const reference = onAddReference ? parseReferenceDragData(event.dataTransfer) : null
    if (reference && onAddReference) {
      event.preventDefault()
      event.stopPropagation()
      setPendingReferences((count) => count + 1)
      void Promise.resolve().then(() => onAddReference(reference)).catch((error) => {
        onReferenceError(error instanceof Error ? error.message : String(error))
      }).finally(() => setPendingReferences((count) => count - 1))
      return
    }
    const files = Array.from(event.dataTransfer.files)
    if (files.length) {
      event.preventDefault()
      addFiles(files)
    }
  }

  return (
    <div className="composer" onDragOver={handleDragOver} onDrop={handleDrop}>
      {banner}
      {(hasAttachments || isRecording || transcribing) && (
        <div className="composer-attachments">
          <div className="composer-attachments-scroll">
            {isRecording && (
              <div
                className="composer-attachment-pill composer-attachment-pill-recording"
                role="status"
                aria-label={`Recording ${formatDuration(recordingDuration)}`}
              >
                <Mic size={12} strokeWidth={2} />
                <SpeechWave levels={dictation.levels} />
                <span>{formatDuration(recordingDuration)}</span>
              </div>
            )}
            {transcribing && (
              <div className="composer-attachment-pill composer-attachment-pill-transcribing" role="status">
                <Loader2 size={12} strokeWidth={2} className="composer-transcribing-spin" />
                <span>Transcribing…</span>
              </div>
            )}
            {/* An attached image opens a preview that steps through the other attached images. */}
            <ImageGalleryProvider images={() => attachedFiles.flatMap(({ id, file, previewUrl }) => (previewUrl ? [{ id, url: previewUrl, filename: file.name }] : []))}>
              {attachedFiles.map(({ id, file, previewUrl }) => (
                <FileAttachment
                  key={id}
                  id={id}
                  filename={file.name}
                  size={file.size}
                  isImage={previewUrl !== undefined}
                  url={previewUrl}
                  onRemove={() => removeFile(id)}
                />
              ))}
            </ImageGalleryProvider>
            {references.map((reference) => (
              <ChatReferencePill key={reference.id} reference={reference} onRemove={() => onRemoveReference(reference.id)} />
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
          {renderInputBackdrop()}
        </div>
        <textarea
          ref={composerInputRef}
          className="composer-input composer-input-mirrored"
          value={input}
          onChange={(e) => {
            setSuggestionsDismissed(false)
            setSelectedSuggestion(0)
            setCaret(readCaret(e.target))
            onInputChange(e.target.value)
          }}
          onSelect={(e) => setCaret(readCaret(e.currentTarget))}
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
            placeholder ?? (loading
              ? sendMode === 'steer'
                ? `Steer the reply · ${formatBinding(STEER_BINDING, platform)} queues`
                : `Queue a follow-up · ${formatBinding(STEER_BINDING, platform)} steers`
              : 'Ask anything · @ files · / commands')
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
          ariaLabel="File, folder and skill suggestions"
          rows={mentionItems.map(
            (item): SuggestionRow => ({
              key: item.kind === 'skill' ? `skill:${item.skill.id}` : `${item.kind}:${item.path}`,
              content: <MentionRowContent item={item} />
            })
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
              content: (
                <>
                  <span className="composer-command-suggestion-name">{skill.name}</span>
                  <span className="composer-command-suggestion-description">{skill.description || skill.id}</span>
                </>
              )
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
          ariaLabel="Slash command suggestions"
          rows={suggestions.map(
            (command): SuggestionRow => ({
              key: command.name,
              content: (
                <>
                  <span className="composer-command-suggestion-name">
                    /{command.name}{command.argsHint ? ` ${command.argsHint}` : ''}
                  </span>
                  <span className="composer-command-suggestion-description">{command.description}</span>
                </>
              )
            })
          )}
          selected={selectedSuggestion}
          onHover={setSelectedSuggestion}
          onPick={(index) => {
            const command = suggestions[index]
            if (command) applySuggestion(command)
          }}
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
        isRecording={isRecording}
        recordingPending={recordingPending}
        transcribing={transcribing}
        onSend={() => submit(sendMode === 'steer' ? { steer: true } : undefined)}
        sendLabel={sendLabel}
        onStop={handleStop}
        onStartRecording={startDictation}
        onStopRecording={dictation.stop}
        allowAttachWhileLoading
        permission={permission}
        dictateWhileStoppable={dictateWhileStoppable}
        extraActions={extraActions}
        {...(sendModeShown ? { sendMode: { mode: sendMode, onSwitch: switchSendMode } } : {})}
      />
    </div>
  )
}

export function formatVoiceDuration(seconds: number): string {
  return formatDuration(seconds)
}

export function buildComposerMessageContent(
  input: string,
  attachedFiles: AttachedFile[],
  voiceMessages: VoiceMessage[],
  browserElements: BrowserElementAttachment[] = [],
  references: ChatReference[] = []
): string {
  const parts: string[] = []
  if (input.trim()) parts.push(input.trim())

  // Images travel as separate vision payloads — only list non-image files here so
  // auto-generated paste names (paste-*.png) never pollute queue/transcript text.
  const nonImageNames = attachedFiles
    .filter((f) => !f.file.type.startsWith('image/') && !f.previewUrl)
    .map((f) => f.file.name)
  if (nonImageNames.length) {
    parts.push(`[Attached files: ${nonImageNames.join(', ')}]`)
  }

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
function renderMarkdownBackdrop(text: string, chip: { start: number; end: number } | null): ReactNode[] {
  const cuts = chip ? [chip.start, chip.end] : []
  const nodes: ReactNode[] = []
  for (const span of composerMarkdownSpans(text)) {
    const bounds = [span.start, ...cuts.filter((cut) => cut > span.start && cut < span.end), span.end]
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const start = bounds[i]
      const end = bounds[i + 1]
      const classes = span.kinds.map((kind) => MARKDOWN_CLASS[kind])
      if (chip && start >= chip.start && end <= chip.end) classes.push('composer-token-chip')
      const piece = text.slice(start, end)
      nodes.push(classes.length ? <span key={start} className={classes.join(' ')}>{piece}</span> : piece)
    }
  }
  return nodes
}
