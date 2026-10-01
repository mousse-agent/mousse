import { create } from 'zustand'
import type { ChatConversation, ChatCreateInput, ChatsSnapshot } from '../../shared/chats'
import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from './appStore'

const EMPTY: ChatsSnapshot = { agents: [], chats: [], devices: [] }
interface ChatsState {
  profileId: string | null
  snapshot: ChatsSnapshot
  conversation: ChatConversation | null
  activeChatId: string | null
  error: string | null
  loading: boolean
  newChatOpen: boolean
  searchOpen: boolean
  search: string
  drafts: Record<string, string>
  activate(profileId: string): void
  refresh(): Promise<void>
  openChat(chatId: string): Promise<void>
  create(input: ChatCreateInput): Promise<void>
  send(text: string): Promise<void>
  cancel(): Promise<void>
  setDraft(chatId: string, draft: string): void
}
const pendingSends = new Map<string, { text: string; clientMessageId: string }>()
let epoch = 0
let refreshOperation: Promise<void> | undefined
const errorText = (error: unknown) => error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error)
export const useChatsStore = create<ChatsState>((set, get) => ({
  profileId: null, snapshot: EMPTY, conversation: null, activeChatId: null, error: null,
  loading: false, newChatOpen: false, searchOpen: false, search: '', drafts: {},
  activate(profileId) {
    if (get().profileId === profileId) return
    epoch += 1
    pendingSends.clear()
    refreshOperation = undefined
    set({ profileId, snapshot: EMPTY, conversation: null, activeChatId: null, error: null, loading: false,
      newChatOpen: false, searchOpen: false, search: '', drafts: {} })
  },
  async refresh() {
    if (refreshOperation) return refreshOperation
    const owner = epoch
    const operation = (async () => {
      try {
        const snapshot = await window.mousse.platformRequest.request<ChatsSnapshot>('chats.snapshot', {})
        if (owner !== epoch) return
        set({ snapshot, error: null })
        const chatId = get().activeChatId
        if (chatId) {
          const conversation = await window.mousse.platformRequest.request<ChatConversation>('chats.get', { chatId })
          if (owner === epoch && get().activeChatId === chatId) set({ conversation })
        }
      } catch (error) { if (owner === epoch) set({ error: errorText(error) }) }
    })()
    refreshOperation = operation
    try { await operation } finally { if (refreshOperation === operation) refreshOperation = undefined }
  },
  async openChat(chatId) {
    if (chatId !== get().activeChatId && !await confirmNavigation()) return
    const owner = epoch
    useAppStore.getState().setSidebarMode('chats')
    set({ activeChatId: chatId, conversation: null, error: null, loading: true })
    try {
      const conversation = await window.mousse.platformRequest.request<ChatConversation>('chats.get', { chatId })
      if (owner === epoch && get().activeChatId === chatId) set({ conversation, loading: false })
    } catch (error) { if (owner === epoch && get().activeChatId === chatId) set({ error: errorText(error), loading: false }) }
  },
  async create(input) {
    if (!await confirmNavigation()) return
    const owner = epoch
    set({ loading: true, error: null })
    try {
      const conversation = await window.mousse.platformRequest.request<ChatConversation>('chats.create', input)
      if (owner !== epoch) return
      set({ conversation, activeChatId: conversation.id, newChatOpen: false, loading: false })
      useAppStore.getState().setSidebarMode('chats')
      await get().refresh()
    } catch (error) { if (owner === epoch) set({ loading: false, error: errorText(error) }) }
  },
  async send(text) {
    const chatId = get().activeChatId
    if (!chatId) return
    const owner = epoch
    set({ loading: true, error: null })
    try {
      const pending = pendingSends.get(chatId)
      const admission = pending?.text === text ? pending : { text, clientMessageId: crypto.randomUUID() }
      pendingSends.set(chatId, admission)
      const conversation = await window.mousse.platformRequest.request<ChatConversation>('chats.send', { chatId, ...admission })
      if (owner !== epoch) return
      pendingSends.delete(chatId)
      get().setDraft(chatId, '')
      if (get().activeChatId === chatId) set({ conversation, loading: false })
      await get().refresh()
    } catch (error) { if (owner === epoch) set({ loading: false, error: errorText(error) }) }
  },
  async cancel() {
    const conversation = get().conversation
    if (!conversation?.run) return
    const owner = epoch
    try {
      const next = await window.mousse.platformRequest.request<ChatConversation>('chats.cancel', { chatId: conversation.id, runId: conversation.run.id })
      if (owner === epoch && get().activeChatId === conversation.id) set({ conversation: next })
    } catch (error) { if (owner === epoch) set({ error: errorText(error) }) }
  },
  setDraft(chatId, draft) { set((state) => ({ drafts: { ...state.drafts, [chatId]: draft } })) }
}))
