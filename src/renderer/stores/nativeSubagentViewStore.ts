import { create } from 'zustand'

/** The native subagent whose live page covers a thread's chat: the thread and the call that started it. */
export interface NativeSubagentView {
  threadId: string
  toolCallId: string
}

interface NativeSubagentViewState {
  open: NativeSubagentView | null
  show: (view: NativeSubagentView) => void
  close: () => void
}

/**
 * Which native subagent (Claude Code's `Agent` call) the chat shows on its own page. It has no thread of its own, so
 * the page is drawn from its parent's transcript and closes back to that chat.
 */
export const useNativeSubagentViewStore = create<NativeSubagentViewState>((set) => ({
  open: null,
  show: (view) => set({ open: view }),
  close: () => set({ open: null })
}))
