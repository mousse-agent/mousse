import { create } from 'zustand'
import type { ChatConversation, ChatCreateInput, ChatsSnapshot } from '../../shared/chats'
import type { BotId } from '../../shared/net'
import type { ChatNetworkBinding } from '../../shared/chatsNetwork'
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
  newChatKind: 'direct' | 'group'
  searchOpen: boolean
  search: string
  drafts: Record<string, string>
  activate(profileId: string): void
  refresh(): Promise<void>
  openChat(chatId: string): Promise<void>
  create(input: ChatCreateInput): Promise<void>
  send(text: string, mentions?: BotId[]): Promise<void>
  publish(): Promise<void>
  loadMore(): Promise<void>
  cancel(): Promise<void>
  setDraft(chatId: string, draft: string): void
}
const pendingSends = new Map<string, { text: string; clientMessageId: string; mentions?: BotId[] }>()
const pendingPublications = new Map<string, string>()
let epoch = 0
let refreshOperation: Promise<void> | undefined
// Polling still checks current authorization and metadata. I retain only the
// already fetched original prefix when the fresh first page proves it unchanged.
function retainLoadedPages(current: ChatConversation | null, fresh: ChatConversation): ChatConversation {
  const held = current?.network, next = fresh.network
  if (!current || current.id !== fresh.id || !held || !next || !held.head || !next.head ||
      held.records.length <= next.records.length || held.records.length > 2048 || next.records.length === 0 ||
      JSON.stringify(held.binding) !== JSON.stringify(next.binding) ||
      held.head.epoch !== next.head.epoch || held.cursor.epoch !== next.head.epoch ||
      next.head.seq < held.head.seq || next.head.seq < held.cursor.seq ||
      JSON.stringify(held.records.slice(0, next.records.length)) !== JSON.stringify(next.records)) return fresh
  return { ...fresh, network: { ...next, records: held.records, cursor: held.cursor,
    nextAfter: held.cursor.seq < next.head.seq ? held.cursor : undefined } }
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error)
export const useChatsStore = create<ChatsState>((set, get) => ({
  profileId: null, snapshot: EMPTY, conversation: null, activeChatId: null, error: null,
  loading: false, newChatOpen: false, newChatKind: 'direct', searchOpen: false, search: '', drafts: {},
  activate(profileId) {
    if (get().profileId === profileId) return
    epoch += 1
    pendingSends.clear()
    pendingPublications.clear()
    refreshOperation = undefined
    set({ profileId, snapshot: EMPTY, conversation: null, activeChatId: null, error: null, loading: false,
      newChatOpen: false, newChatKind: 'direct', searchOpen: false, search: '', drafts: {} })
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
          if (owner === epoch && get().activeChatId === chatId) set({ conversation: retainLoadedPages(get().conversation, conversation) })
        }
      } catch (error) {
        if (owner === epoch) {
          const denied = ['forbidden', 'not_member', 'revoked', 'bad_delegation', 'keystore_locked', 'not_enrolled', 'profile_mismatch', 'chat_not_found', 'cancelled'].includes(String((error as { code?: unknown })?.code ?? ''))
          set({ error: errorText(error), ...(denied && get().conversation?.network ? { conversation: null } : {}) })
        }
      }
    })()
    refreshOperation = operation
    try { await operation } finally { if (refreshOperation === operation) refreshOperation = undefined }
  },
  async openChat(chatId) {
    if (chatId !== get().activeChatId && !await confirmNavigation()) return
    const owner = epoch
    useAppStore.getState().setThreadsSidebarView('chats')
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
      useAppStore.getState().setThreadsSidebarView('chats')
      useAppStore.getState().setSidebarMode('chats')
      await get().refresh()
    } catch (error) { if (owner === epoch) set({ loading: false, error: errorText(error) }) }
  },
  async send(text, mentions) {
    const chatId = get().activeChatId
    if (!chatId) return
    const owner = epoch
    set({ loading: true, error: null })
    try {
      const pending = pendingSends.get(chatId)
      const selection = mentions ? [...mentions].sort() : undefined
      const admission = pending?.text === text && JSON.stringify(pending.mentions) === JSON.stringify(selection) ? pending : { text, clientMessageId: crypto.randomUUID(), ...(selection ? { mentions: selection } : {}) }
      pendingSends.set(chatId, admission)
      const conversation = await window.mousse.platformRequest.request<ChatConversation>('chats.send', { chatId, ...admission })
      if (owner !== epoch) return
      pendingSends.delete(chatId)
      get().setDraft(chatId, '')
      if (get().activeChatId === chatId) set({ conversation, loading: false })
      await get().refresh()
    } catch (error) { if (owner === epoch) set({ loading: false, error: errorText(error) }) }
  },
  async publish() {
    const conversation = get().conversation
    if (!conversation || conversation.kind !== 'group' || conversation.presentation === 'network' || conversation.network || conversation.run?.state === 'running') return
    const owner = epoch, chatId = conversation.id
    const publicationId = pendingPublications.get(chatId) ?? crypto.randomUUID()
    pendingPublications.set(chatId, publicationId)
    set({ loading: true, error: null })
    try {
      await window.mousse.platformRequest.request<ChatNetworkBinding>('chats.publish', { chatId, publicationId })
      if (owner !== epoch) return
      pendingPublications.delete(chatId)
      await get().refresh()
      if (owner === epoch) set({ loading: false })
    } catch (error) { if (owner === epoch) set({ loading: false, error: `Publication needs checking: ${errorText(error)}` }) }
  },
  async loadMore() {
    const conversation = get().conversation, network = conversation?.network
    if (!conversation || !network?.nextAfter || get().loading) return
    const owner = epoch, chatId = conversation.id, binding = network.binding.publicationId
    set({ loading: true, error: null })
    try {
      const page = await window.mousse.platformRequest.request<ChatConversation>('chats.get', { chatId, after: network.nextAfter, limit: 128 })
      const current = get().conversation
      if (owner !== epoch || get().activeChatId !== chatId || current?.network?.binding.publicationId !== binding) return
      if (current !== conversation) { set({ loading: false }); return }
      if (!page.network || page.network.binding.publicationId !== binding || page.network.cursor.epoch !== network.cursor.epoch) throw new Error('Conversation changed; refresh it before continuing')
      const records = [...network.records, ...page.network.records]
      if (records.length > 2048) throw new Error('This view has reached 2,048 records. Refresh to start a new page.')
      set({ conversation: { ...page, network: { ...page.network, records } }, loading: false })
    } catch (error) { if (owner === epoch && get().activeChatId === chatId) set({ loading: false, error: errorText(error) }) }
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
