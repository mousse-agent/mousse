import { create } from 'zustand'
import type { LocalTtsModelId, LocalTtsModelStatus, ReadAloudSelection } from '../../shared/readAloud'
import { useAppStore } from '../stores/appStore'
import { currentSpeechPreferences, voiceFor } from '../speech/speechPreferences'
import { disposeLocalEngine, speakWithLocalModel } from './localEngine'
import { PauseGate, type SpeakOptions } from './playback'
import { speakWithProvider } from './providerEngine'
import { loadReadAloudSelection, saveReadAloudSelection } from './selection'
import { markdownToSpeechText } from './speechText'

export type ReadAloudStatus = 'idle' | 'loading' | 'playing' | 'paused'

interface PendingRead {
  key: string
  text: string
  threadId: string | null
}

export interface ReadAloudOptions {
  /** False for audio that belongs to no thread, like the sample in Settings. Defaults to true. */
  inThread?: boolean
}

interface ReadAloudState {
  /** Message that is loading or playing; only one message speaks at a time. */
  activeKey: string | null
  /** Thread the speaking message belongs to, for the indicator in the threads sidebar. */
  threadId: string | null
  status: ReadAloudStatus
  error: { key: string; message: string } | null
  selection: ReadAloudSelection | null
  selectionProfileId: string | null
  pickerOpen: boolean
  /** The message to read once the user confirms a model in the picker. */
  pending: PendingRead | null
  syncProfile: (profileId: string) => void
  toggle: (key: string, markdown: string, options?: ReadAloudOptions) => void
  stop: () => void
  /** Pauses or resumes the message that is playing. */
  togglePause: () => void
  openPicker: () => void
  closePicker: () => void
  confirmPicker: (selection: ReadAloudSelection) => void
  setSelection: (selection: ReadAloudSelection | null) => void
  deleteLocalModel: (modelId: LocalTtsModelId) => Promise<LocalTtsModelStatus>
}

const ERROR_VISIBLE_MS = 6000

let session: { id: number; controller: AbortController; pause: PauseGate } | null = null
let lastSessionId = 0
let errorTimer: ReturnType<typeof setTimeout> | null = null

export const useReadAloudStore = create<ReadAloudState>((set, get) => {
  const showError = (key: string, message: string): void => {
    if (errorTimer) clearTimeout(errorTimer)
    set({ error: { key, message } })
    errorTimer = setTimeout(() => {
      errorTimer = null
      set((state) => (state.error?.key === key ? { error: null } : state))
    }, ERROR_VISIBLE_MS)
  }

  const endSession = (): void => {
    session?.controller.abort()
    session = null
    set({ activeKey: null, threadId: null, status: 'idle' })
  }

  const start = ({ key, text, threadId }: PendingRead, selection: ReadAloudSelection): void => {
    endSession()
    const mine = { id: ++lastSessionId, controller: new AbortController(), pause: new PauseGate() }
    session = mine
    set({ activeKey: key, threadId, status: 'loading', error: null })
    const options: SpeakOptions = {
      signal: mine.controller.signal,
      onPlaying: () => {
        if (session === mine) set({ status: mine.pause.paused ? 'paused' : 'playing' })
      },
      voice: voiceFor(currentSpeechPreferences(), selection),
      speed: () => currentSpeechPreferences().speed,
      pause: mine.pause
    }
    const run =
      selection.source === 'local'
        ? speakWithLocalModel(text, options)
        : speakWithProvider(selection.providerId, selection.modelId, text, options)
    run
      .catch((error: unknown) => {
        if (session === mine) showError(key, error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (session !== mine) return
        session = null
        set({ activeKey: null, threadId: null, status: 'idle' })
      })
  }

  return {
    activeKey: null,
    threadId: null,
    status: 'idle',
    error: null,
    selection: null,
    selectionProfileId: null,
    pickerOpen: false,
    pending: null,

    syncProfile: (profileId) => {
      if (get().selectionProfileId === profileId) return
      if (get().selectionProfileId !== null) endSession()
      set({ selectionProfileId: profileId, selection: loadReadAloudSelection(profileId), pickerOpen: false, pending: null })
    },

    toggle: (key, markdown, options) => {
      const state = get()
      if (state.activeKey === key && state.status !== 'idle') {
        endSession()
        return
      }
      get().syncProfile(useAppStore.getState().profileId)
      const text = markdownToSpeechText(markdown)
      if (!text) {
        endSession()
        showError(key, 'There is nothing to read aloud in this message')
        return
      }
      const read: PendingRead = { key, text, threadId: options?.inThread === false ? null : useAppStore.getState().activeThreadId }
      const { selection } = get()
      if (!selection) {
        endSession()
        set({ pickerOpen: true, pending: read })
        return
      }
      start(read, selection)
    },

    stop: endSession,

    togglePause: () => {
      const { status } = get()
      if (!session || (status !== 'playing' && status !== 'paused')) return
      const paused = status === 'playing'
      session.pause.set(paused)
      set({ status: paused ? 'paused' : 'playing' })
    },

    openPicker: () => {
      get().syncProfile(useAppStore.getState().profileId)
      set({ pickerOpen: true, pending: null })
    },

    closePicker: () => set({ pickerOpen: false, pending: null }),

    confirmPicker: (selection) => {
      const { pending } = get()
      get().setSelection(selection)
      set({ pickerOpen: false, pending: null })
      if (pending) start(pending, selection)
    },

    setSelection: (selection) => {
      const profileId = useAppStore.getState().profileId
      saveReadAloudSelection(profileId, selection)
      set({ selection, selectionProfileId: profileId })
    },

    deleteLocalModel: async (modelId) => {
      const { selection } = get()
      const usesModel = selection?.source === 'local' && selection.modelId === modelId
      // Playback may be reading from the files that are about to disappear.
      if (usesModel || get().status !== 'idle') endSession()
      disposeLocalEngine()
      const status = await window.mousse.readAloud.deleteLocalModel(modelId)
      if (usesModel) get().setSelection(null)
      return status
    }
  }
})
