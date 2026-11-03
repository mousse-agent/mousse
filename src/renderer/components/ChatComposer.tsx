import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Loader2, Mic, X } from '../lib/icons'
import { SpeechWave } from '../speech/SpeechWave'
import type { ProviderWithStatus } from '../lib/providerSnapshots'
import type {
  BrowserElementAttachment,
  ChatMode,
  ContextUsageSnapshot,
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
import { ComposerFooter } from './ComposerFooter'
import { BrowserElementPill } from './BrowserElementPill'
import { FileAttachment } from '../chat/components/agent-elements/input/file-attachment'
import { formatBrowserElementBlock } from '../utils/messageAttachments'
import { collectImageFilesFromDataTransfer } from '../utils/imageAttachments'
import type { ChatReference } from '../../shared/chatReferences'
import { formatChatReferences, MOUSSE_REFERENCE_MIME, parseReferenceDragData } from '../../shared/chatReferences'
import { ChatReferencePill } from './ReferencePill'
import { insertTranscript } from '../dictation/insertTranscript'
import { useDictation } from '../dictation/useDictation'
import { useCommand } from '../commands/commandRegistry'

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
  onAddReference?: (reference: ChatReference) => void | Promise<void>
  onRemoveReference?: (id: string) => void
  onReferenceError?: (message: string) => void
  enabledSkills: SkillDescriptor[]
  providers: ProviderWithStatus[]
  selectedProviderId: string
  /** The selection's instance, when it names one. */
  selectedInstanceId?: string
  selectedModelId: string
  modelMenuOpen: boolean
  onModelMenuOpenChange: (open: boolean) => void
  onModelSelect: (providerId: string, modelId: string) => void
  /** Display the selected model without allowing this composer to mutate it. */
  modelReadOnly?: boolean
  onOpenSettings: () => void
  contextUsage: ContextUsageSnapshot
  contextOpen: boolean
  onContextOpenChange: (open: boolean) => void
  loading?: boolean
  disabled?: boolean
  placeholder?: string
  /** What the empty input says while a turn runs; the composer queues the next message unless the parent says otherwise. */
  loadingPlaceholder?: string
  /** Receives the inline `@skill` token (if any) so the parent can send this
   * prompt in skill mode without flipping the global chat mode. */
  onSend: (skillMode?: SkillChatMode) => void
  onStop?: () => void
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
  onAddReference = () => {},
  onRemoveReference = () => {},
  onReferenceError = () => {},
  enabledSkills,
  providers,
  selectedProviderId,
  selectedInstanceId,
  selectedModelId,
  modelMenuOpen,
  onModelMenuOpenChange,
  onModelSelect,
  modelReadOnly = false,
  onOpenSettings,
  contextUsage,
  contextOpen,
  onContextOpenChange,
  loading = false,
  disabled = false,
  placeholder = 'Describe a task or ask a question',
  loadingPlaceholder = 'Running… send queues next',
  onSend,
  onStop,
  disableSkillsPicker = false,
  banner,
  searchMentions,
  mentionScope,
  permission
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  // Two composers can be mounted at once (the local thread behind a remote one): the shown one answers.
  useCommand('composer.focus', () => composerInputRef.current?.focus(), () => !disabled && isShown(composerInputRef.current))
  const resizeDraft = useCallback(() => {
    const inputElement = composerInputRef.current
    if (!inputElement) return
    inputElement.style.height = '0px'
    const height = Math.max(64, Math.min(200, inputElement.scrollHeight))
    inputElement.style.removeProperty('height')
    inputElement.style.setProperty('--draft-input-height', `${height}px`)
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
  // Dictated text goes where the caret is when the transcript arrives, then the box gets focus.
  const insertDictation = (text: string) => {
    const node = composerInputRef.current
    const current = node?.value ?? inputValueRef.current
    const inserted = insertTranscript(current, node?.selectionStart ?? current.length, node?.selectionEnd ?? current.length, text)
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
  const [pendingReferences, setPendingReferences] = useState(0)
  // With the picker disabled, `/skills` stays literal text so it is sent to the agent as a prompt.
  const skillsPickerDisabled = disableSkillsPicker
  // Inline `@skill` token embedded in the typed text (painted as a pill by
  // the input backdrop). The global chat mode is untouched: the skill applies
  // to the submitted prompt only (passed to onSend as a mode override), and
  // the token is stripped from the sent text. Backspace deletes it like text.
  const skillToken = skillsPickerDisabled
    ? null
    : findInlineSkillToken(input, enabledSkills)
  const backdropRef = useRef<HTMLDivElement>(null)

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
        ? 'Large project: showing the first matches, keep typing'
        : null
  // With nothing to pick and nothing to say the list stays closed, so Enter sends the text as typed.
  const showMentionPicker =
    !disabled && !suggestionsDismissed && mentionQuery !== null && (mentionItems.length > 0 || mentionFooter !== null)

  const suggestions = showSkillsPicker || showMentionPicker ? [] : filterComposerCommandSuggestions(input).filter((command) => !skillsPickerDisabled || command.name !== 'skills')
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
    void Promise.resolve().then(() => onAddReference(reference)).catch((error) => {
      onReferenceError(error instanceof Error ? error.message : String(error))
    }).finally(() => setPendingReferences((count) => count - 1))
  }

  const submit = () => {
    if (!canSend) return
    const skillMode: SkillChatMode | undefined = skillToken
      ? { type: 'skill', skillId: skillToken.skillId }
      : undefined
    onSend(skillMode)
  }

  const handleInputScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    // The token backdrop paints behind the textarea: keep it scroll-locked.
    if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop
  }

  const renderInputBackdrop = () => {
    if (!skillToken) return input.endsWith('\n') ? <>{input}{ '\u200B'}</> : input
    const before = input.slice(0, skillToken.index)
    const tokenText = input.slice(skillToken.index, skillToken.index + skillToken.length)
    const after = input.slice(skillToken.index + skillToken.length)
    return (
      <>
        {before}
        <span className="composer-token-chip">{tokenText}</span>
        {after}
        {input.endsWith('\n') ? '\u200B' : null}
      </>
    )
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
              // An exact no-argument command is already complete: execute it instead of
              // making users press Enter twice (first to re-apply the same suggestion).
              if (e.key === 'Enter' && !suggestion.argsHint && input.trim().toLowerCase() === `/${suggestion.name}`) {
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const handleStop = () => {
    onStop?.()
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return
    if (event.dataTransfer.types.includes(MOUSSE_REFERENCE_MIME) || event.dataTransfer.types.includes('Files')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return
    const reference = parseReferenceDragData(event.dataTransfer)
    if (reference) {
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
      {pendingReferences > 0 && <div className="composer-attachments" role="status">Attaching reference…</div>}
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
          className="composer-input"
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
            loading
              ? loadingPlaceholder
              : placeholder
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
              ? 'No skills enabled. Enable skills in Settings.'
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

      {recordingPending && <p role="status">Requesting microphone access…</p>}
      {dictation.notice && <p role="status">{dictation.notice}</p>}
      {dictation.error && <div className="composer-recording-error" role="alert">
        <p>{dictation.error.message}</p>
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading || disabled || recordingPending || transcribing} onClick={dictation.start}>Retry microphone</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={dictation.dismissError}>Dismiss</button>
      </div>}
      <ComposerFooter
        providers={providers}
        selectedProviderId={selectedProviderId}
        selectedInstanceId={selectedInstanceId}
        selectedModelId={selectedModelId}
        modelMenuOpen={modelMenuOpen}
        onModelMenuOpenChange={onModelMenuOpenChange}
        onModelSelect={onModelSelect}
        modelReadOnly={modelReadOnly}
        onOpenSettings={onOpenSettings}
        contextUsage={contextUsage}
        contextOpen={contextOpen}
        onContextOpenChange={onContextOpenChange}
        onAttachClick={() => fileInputRef.current?.click()}
        loading={loading}
        disabled={disabled}
        canSend={canSend}
        isRecording={isRecording}
        recordingPending={recordingPending}
        transcribing={transcribing}
        onSend={submit}
        onStop={handleStop}
        onStartRecording={dictation.start}
        onStopRecording={dictation.stop}
        allowAttachWhileLoading
        permission={permission}
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
