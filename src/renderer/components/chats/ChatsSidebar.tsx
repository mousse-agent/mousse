import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { BellOff, ChevronRight, EyeOff, Globe, Pin, Plus } from '../../lib/icons'
import type { ChatSummary } from '../../../shared/chats'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import type { BotMarks } from '../../../shared/bots/personal/marks'
import { botComputers, botFilterOn, effectiveBotFilter, hiddenBotCount, shownBots } from '../../lib/botList'
import { FilterLines } from '../sidebar/ThreadFilterBar'
import { BotsFilterMenu } from './BotsFilterMenu'
import { useAppStore } from '../../stores/appStore'
import { useChatsStore } from '../../stores/chatsStore'
import { botFaceState, useBotsPolling, useBotsStore } from '../../stores/botsStore'
import { BotFace } from '../bots/face/BotFace'
import { BotHoverCard } from '../bots/BotHoverCard'
import { botRowLine } from '../bots/botChatShape'
import { formatMessageTime } from '../../chat/components/agent-elements/utils/message-time'
import { Collapse } from '../ui/Collapse'
import { useReplyPreviews } from '../../lib/replyPreviewSetting'
import { OpenNetworkChatDialog } from './OpenNetworkChatDialog'
import { BotRowMenu, type BotRowAction, type BotRowMenuTarget } from '../ThreadsContextMenu'
import { setBotChecklistHidden, useBotChecklistHidden } from '../bots/botChecklistSetting'
import { ComputerBadgeView } from '../ComputerBadge'
import { offlineLabel, useComputer } from '../../lib/computers'
import '../../styles/chats.css'
import '../../styles/bots.css'

const NO_MARKS: BotMarks = Object.freeze({})

export function ChatAvatar({ name, group = false, small = false }: { name: string; group?: boolean; small?: boolean }) {
  const color = [...name].reduce((value, char) => value + char.charCodeAt(0), 0) % 5
  return <span className={`chat-avatar chat-color-${color}${small ? ' small' : ''}${group ? ' group' : ''}`} aria-hidden="true">{group ? '#' : name.slice(0, 1).toUpperCase()}</span>
}
/**
 * A sidebar section's heading. Its title folds the section; each section remembers its choice for the profile, and all
 * start open.
 */
function useSectionOpen(key: string): [boolean, () => void] {
  const collapsed = useAppStore((s) => s.chatsSidebarCollapsed[key] === true)
  return [!collapsed, () => useAppStore.getState().setChatsSidebarSectionCollapsed(key, !collapsed)]
}

function SectionHeading({ title, open, onToggle, children }: { title: string; open: boolean; onToggle(): void; children?: ReactNode }) {
  return <div className="chat-section-heading">
    <h2><button type="button" className="chat-section-toggle" aria-expanded={open} onClick={onToggle}>{title}<ChevronRight size={12} strokeWidth={2} className="chat-section-chevron" aria-hidden /></button></h2>
    {children}
  </div>
}

/**
 * One bot in the Bots list: its face, its name and the time of its latest message, and under them what it does now in
 * coloured words (`botRowLine`). An idle bot shows its latest reply there instead, when reply previews are on, and its
 * face sleeps. Unread messages show as a count until its chat opens, and a bot marked unread here as a dot. A pinned
 * bot shows a pin, a muted one a bell struck through, and a hidden one (shown by Show hidden) fades with an eye struck
 * through. A right-click, or the menu key, opens its menu.
 */
function BotRow({ bot, marks, active, happyUntil, onOpen, onMenu }: { bot: BotSummary; marks: BotMarks; active: boolean; happyUntil: number | undefined; onOpen(): void; onMenu(event: ReactMouseEvent<HTMLButtonElement>): void }) {
  // A bot of another computer that can't be reached now: its row fades and says so, and its face dozes under a moon.
  const away = Boolean(bot.lives?.offline)
  const line = away ? { tone: 'idle' as const, text: 'Offline', resting: true } : botRowLine(bot)
  const replyPreviews = useReplyPreviews()
  const preview = line.resting && replyPreviews && !away ? bot.lastReply : undefined
  const time = bot.last ? formatMessageTime(bot.last.at) : undefined
  const unread = active ? 0 : bot.unread
  const markedUnread = !active && !unread && Boolean(marks.unread)
  return <button type="button" className="bot-row" data-away={away || undefined} data-hidden={marks.hidden || undefined} aria-current={active || undefined} title={bot.stateText && bot.state !== 'idle' && !away ? `${bot.name}: ${bot.stateText}` : bot.name} aria-label={`Message ${bot.name}`} onClick={onOpen} onContextMenu={onMenu}>
    <BotFace look={bot.look} state={botFaceState(bot, happyUntil)} sleep={line.resting} away={away} size={36} view="head" />
    <span className="bot-row-text">
      <span className="bot-row-head">
        {marks.pinnedAt && <Pin size={11} strokeWidth={2} className="bot-row-mark" aria-label="Pinned" />}
        <span className="bot-row-name">{bot.name}</span>
        {marks.muted && <span className="bot-row-mark" title="Muted"><BellOff size={12} strokeWidth={2} aria-label="Muted" /></span>}
        {marks.hidden && <span className="bot-row-mark" title="Hidden"><EyeOff size={12} strokeWidth={2} aria-label="Hidden" /></span>}
        {bot.lives && <BotComputerBadge lives={bot.lives} />}
        {unread > 0 && <span className="bot-row-unread" aria-label={`${unread} unread`}>{unread}</span>}
        {markedUnread && <span className="bot-row-unread bot-row-unread-dot" role="img" aria-label="Marked unread" />}
        {time && <span className="bot-row-time">{time}</span>}
      </span>
      {preview
        ? <span className="bot-row-state bot-row-preview" data-tone="idle">{preview}</span>
        : <span className="bot-row-state" data-tone={line.tone}>{line.text}</span>}
    </span>
  </button>
}

/** The computer a bot of another computer lives on, as thread rows show theirs: struck through while it is offline. */
function BotComputerBadge({ lives }: { lives: NonNullable<BotSummary['lives']> }) {
  const computer = useComputer(lives.node)
  return <ComputerBadgeView name={lives.name} state={lives.offline ? 'offline' : 'online'} offline={offlineLabel(computer, Date.now())} of="bot" className="bot-row-computer" />
}

/** Where a bot's menu opens, and the row it returns the focus to. */
interface BotMenuAt { botId: string; x: number; y: number; row: HTMLElement }

/** What a bot row's menu item does. Marks stay on this computer; setup is the bot's own (this computer's bots only). */
function botRowAction(bot: BotSummary, action: BotRowAction, checklistHidden: boolean): void {
  const store = useBotsStore.getState()
  const marks = store.marks[bot.id] ?? {}
  if (action === 'pin') void store.setMark(bot.id, 'pinned', !marks.pinnedAt)
  else if (action === 'read') void store.readAll(bot.id)
  else if (action === 'unread') void store.setMark(bot.id, 'unread', true)
  else if (action === 'mute') void store.setMark(bot.id, 'muted', !marks.muted)
  else if (action === 'hide') void store.setMark(bot.id, 'hidden', !marks.hidden)
  else if (action === 'checklist') setBotChecklistHidden(bot.id, !checklistHidden)
  // About is a panel of the bot's chat: the chat opens first.
  else if (action === 'about') void useChatsStore.getState().openBot(bot.id).then(() => { if (useChatsStore.getState().activeBotId === bot.id) useBotsStore.setState({ aboutOpen: true }) })
  else if (action === 'rename' || action === 'look' || action === 'delete') useBotsStore.setState({ dialog: { kind: action, botId: bot.id }, error: null })
  else if (action === 'pause') void (bot.state === 'paused' ? store.resume(bot.id) : store.pause(bot.id))
  else if (action === 'private') void store.makePrivate(bot.id)
}

/** A bot row's menu, kept outside the row's hover card. Closing it returns the focus to the row unless it moved on. */
function BotRowMenuAt({ at, onClose }: { at: BotMenuAt; onClose(): void }) {
  const checklistHidden = useBotChecklistHidden(at.botId)
  const bot = useBotsStore((s) => s.bots.find((entry) => entry.id === at.botId))
  const marks = useBotsStore((s) => s.marks[at.botId])
  const close = () => {
    onClose()
    requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) at.row.focus({ preventScroll: true }) })
  }
  // The bot left the list (deleted, or this computer lost it): its menu goes with it.
  useEffect(() => { if (!bot) onClose() }, [bot, onClose])
  if (!bot) return null
  const target: BotRowMenuTarget = {
    name: bot.name,
    pinned: Boolean(marks?.pinnedAt),
    unread: bot.unread > 0 || Boolean(marks?.unread),
    readNeedsComputer: bot.unread > 0,
    muted: Boolean(marks?.muted),
    hidden: Boolean(marks?.hidden),
    checklistHidden,
    ...(bot.lives?.offline ? { offlineComputer: bot.lives.name } : {}),
    // A bot of another computer is set up there (slice 10 brings that here): nothing of it is offered yet.
    ...(bot.lives ? {} : { setup: { paused: bot.state === 'paused', canWall: bot.reach !== undefined && bot.reach !== 'this_computer' } })
  }
  return <BotRowMenu x={at.x} y={at.y} target={target} onClose={close} onAction={(action) => { botRowAction(bot, action, checklistHidden); close() }} />
}

/** A row's pin, shown on hover and focus, as thread rows have it. */
function BotPinButton({ bot, pinned }: { bot: BotSummary; pinned: boolean }) {
  return <span className="bot-row-actions">
    <button type="button" className={`bot-row-action${pinned ? ' active' : ''}`} aria-label={pinned ? `Unpin ${bot.name}` : `Pin ${bot.name}`} title={pinned ? 'Unpin' : 'Pin'}
      onClick={(event) => { event.stopPropagation(); void useBotsStore.getState().setMark(bot.id, 'pinned', !pinned) }}>
      <Pin size={13} strokeWidth={2} aria-hidden="true" />
    </button>
  </span>
}

export function ChatsSidebar() {
  const snapshot = useChatsStore((s) => s.snapshot)
  const activeId = useChatsStore((s) => s.activeChatId)
  const openChat = useChatsStore((s) => s.openChat)
  // A bot being opened shows as chosen from the click on (`openingBotId`).
  const activeBotId = useChatsStore((s) => s.openingBotId ?? s.activeBotId)
  const openBot = useChatsStore((s) => s.openBot)
  const bots = useBotsStore((s) => s.bots)
  const happy = useBotsStore((s) => s.happy)
  const marks = useBotsStore((s) => s.marks)
  const filter = useBotsStore((s) => s.filter)
  const botsProfile = useBotsStore((s) => s.profileId)
  // The marks and the saved filter are read when the list shows, never at app open.
  useEffect(() => { useBotsStore.getState().showList() }, [botsProfile])
  const [networkOpen, setNetworkOpen] = useState(false)
  const [botMenu, setBotMenu] = useState<BotMenuAt | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const filterButton = useRef<HTMLButtonElement>(null)
  const closeFilter = useCallback((refocus: boolean) => {
    setFilterOpen(false)
    if (refocus) filterButton.current?.focus()
  }, [])
  const openBotMenu = (bot: BotSummary) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const row = event.currentTarget
    // From the keyboard there is no pointer: the menu opens under the row.
    const rect = row.getBoundingClientRect()
    const fromKeyboard = event.clientX === 0 && event.clientY === 0
    setBotMenu({ botId: bot.id, x: fromKeyboard ? rect.left + 12 : event.clientX, y: fromKeyboard ? rect.bottom : event.clientY, row })
  }
  // The sidebar lists the bots itself: after a restart it shows without the chat pane.
  useBotsPolling()
  const newBot = () => useBotsStore.getState().openNewBot()
  const row = (chat: ChatSummary) => <button type="button" key={chat.id} className={`chat-list-row${chat.id === activeId ? ' active' : ''}`} onClick={() => void openChat(chat.id)}>
    <ChatAvatar name={chat.name} group={chat.kind === 'group'} />
    <span className="chat-list-text"><span className="chat-list-name">{chat.name}</span><span className="chat-list-preview">{chat.presentation === 'network' ? 'Space conversation' : chat.run?.state === 'running' ? 'Working…' : chat.lastMessage?.text || `${chat.participants.filter((p) => p.kind === 'agent').length} agent${chat.kind === 'group' ? 's' : ''}`}</span></span>
    {chat.run?.state === 'running' && <span className="chat-working-dot" aria-label="Working" />}
  </button>
  const groups = snapshot.chats.filter((chat) => chat.kind === 'group')
  // Pinned bots first, then the bot that spoke last, this computer's and the others' together; the filter narrows them
  // and hidden bots stay out until Show hidden (lib/botList.ts).
  const listed = useMemo(() => shownBots(bots, marks, filter), [bots, marks, filter])
  const filterOn = botFilterOn(effectiveBotFilter(filter, bots))
  const computers = useMemo(() => botComputers(bots), [bots])
  const hidden = hiddenBotCount(bots, marks)
  const [botsOpen, toggleBots] = useSectionOpen('bots')
  const [groupsOpen, toggleGroups] = useSectionOpen('groups')
  const [recentOpen, toggleRecent] = useSectionOpen('recent')
  // Recent: direct chats, the latest first. Bots are listed once, in the Bots list above, with their faces and unread counts.
  const recent = snapshot.chats.filter((chat) => chat.kind === 'direct')
    .map((chat) => ({ at: chat.lastMessage?.createdAt ?? chat.updatedAt, row: () => row(chat) }))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  return <div className="chats-sidebar-content">
    <section aria-label="Bots"><SectionHeading title="Bots" open={botsOpen} onToggle={toggleBots}><span className="chat-section-actions">
      {bots.length > 0 && <button ref={filterButton} type="button" className="bots-filter-button" data-set={filterOn || undefined} aria-label="Filter bots" title={filterOn ? 'Filter is on' : 'Filter'} aria-haspopup="menu" aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)}><FilterLines size={15} /></button>}
      <button aria-label="New bot" title="New bot" onClick={newBot}><Plus size={15} /></button>
    </span></SectionHeading>
      <Collapse open={botsOpen} itemCount={listed.length}>
        {!bots.length
          ? <p className="chat-empty-hint">No bots yet. Press + to make one.</p>
          : listed.length
            ? <div className="bot-list">{listed.map((bot) => {
              const own = marks[bot.id] ?? NO_MARKS
              return <BotHoverCard key={bot.id} bot={bot}>
                <BotRow bot={bot} marks={own} active={bot.id === activeBotId} happyUntil={happy[bot.id]} onOpen={() => void openBot(bot.id)} onMenu={openBotMenu(bot)} />
                <BotPinButton bot={bot} pinned={Boolean(own.pinnedAt)} />
              </BotHoverCard>
            })}</div>
            : <p className="chat-empty-hint">{filterOn ? 'No bots match the filter' : 'Every bot is hidden'}</p>}
      </Collapse>
      {filterOpen && <BotsFilterMenu anchorRef={filterButton} filter={effectiveBotFilter(filter, bots)} computers={computers} hidden={hidden} onChange={(change) => useBotsStore.getState().setFilter(change)} onClose={closeFilter} />}
    </section>
    <section aria-label="Groups"><SectionHeading title="Groups" open={groupsOpen} onToggle={toggleGroups}><span className="chat-section-actions"><button aria-label="Open a Space" title="Open a Space" onClick={() => setNetworkOpen(true)}><Globe size={15} /></button>{!!snapshot.agents.length && <button aria-label="New group" title="New group" onClick={() => useChatsStore.setState({ newChatOpen: true, newChatKind: 'group' })}><Plus size={15} /></button>}</span></SectionHeading>
      <Collapse open={groupsOpen} itemCount={groups.length}>{groups.map(row)}{!groups.length && <p className="chat-empty-hint">No groups</p>}</Collapse>
    </section>
    {!!recent.length && <section className="chat-recent-section" aria-label="Recent chats"><SectionHeading title="Recent" open={recentOpen} onToggle={toggleRecent} />
      <Collapse open={recentOpen} itemCount={recent.length}>{recent.map((entry) => entry.row())}</Collapse>
    </section>}
    {networkOpen && <OpenNetworkChatDialog onClose={() => setNetworkOpen(false)} />}
    {/* A right-click on another row opens its menu as this one hears it and closes: only this menu's own closes it. */}
    {botMenu && <BotRowMenuAt key={`${botMenu.botId}:${botMenu.x}:${botMenu.y}`} at={botMenu} onClose={() => setBotMenu((shown) => (shown === botMenu ? null : shown))} />}
  </div>
}
