import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import type { BotMemoryEntry } from '../../../shared/bots/personal/memory'
import { useBotsStore } from '../../stores/botsStore'
import { BotDialogFrame } from './BotDialogs'

const NO_ENTRIES: BotMemoryEntry[] = []

/** The owner's wishes (`owner`) and the bot's own notes (`note`, and run notes from its unattended runs). */
export function memorySplit(entries: readonly BotMemoryEntry[]): { wishes: BotMemoryEntry[]; notes: BotMemoryEntry[] } {
  return { wishes: entries.filter((entry) => entry.kind === 'owner'), notes: entries.filter((entry) => entry.kind !== 'owner') }
}

/** "3 wishes · 5 notes", leaving out an empty side; "Nothing yet" for none. */
export function memorySplitText(entries: readonly BotMemoryEntry[]): string {
  const { wishes, notes } = memorySplit(entries)
  const parts = [
    wishes.length ? `${wishes.length} ${wishes.length === 1 ? 'wish' : 'wishes'}` : '',
    notes.length ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}` : ''
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing yet'
}

/** "12 Nov", or "12 Nov 2025" in another year. */
function shortDate(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

/** A reply's "Saved to memory" names the words it saved, cut short: the entry they start. */
function matches(entry: BotMemoryEntry, focus: string): boolean {
  const head = focus.replace(/…$/, '').trim().toLowerCase()
  return Boolean(head) && (entry.text ?? '').replace(/\s+/g, ' ').toLowerCase().startsWith(head)
}

function MemoryEntry({ bot, entry, focused, canEdit }: { bot: BotSummary; entry: BotMemoryEntry; focused: boolean; canEdit: boolean }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'forget'>('view')
  const [words, setWords] = useState(entry.text ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const row = useRef<HTMLLIElement>(null)
  const store = useBotsStore.getState
  useEffect(() => { if (focused) row.current?.scrollIntoView({ block: 'center' }) }, [focused])
  useEffect(() => { if (mode !== 'edit') setWords(entry.text ?? '') }, [entry.text, mode])
  const save = async () => {
    const text = words.trim()
    if (!text || text === entry.text) { setMode('view'); return }
    setBusy(true)
    setError(null)
    const failed = await store().editMemory(bot.id, entry.ref, text)
    setBusy(false)
    if (failed) setError(failed)
    else setMode('view')
  }
  const forget = async () => {
    setBusy(true)
    setError(null)
    const failed = await store().forgetMemory(bot.id, entry.id)
    // Forgotten, the entry leaves the list; a refusal stays on it.
    if (failed) { setBusy(false); setError(failed) }
  }
  const date = shortDate(entry.learnedAt)
  return <li ref={row} className={`bot-memory-entry${focused ? ' is-focused' : ''}${mode !== 'view' ? ' is-open' : ''}`} data-memory-id={entry.id}>
    {mode === 'edit'
      ? <textarea className="bot-new-text bot-memory-edit" aria-label="Memory text" value={words} disabled={busy} autoFocus
        onChange={(event) => setWords(event.target.value)}
        onKeyDown={(event) => {
          // Escape leaves the edit, not the dialog; Enter saves, Shift+Enter is a new line.
          if (event.key === 'Escape') { event.stopPropagation(); setMode('view'); setError(null) }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void save() }
        }} />
      : <p className="bot-memory-text">{entry.text}</p>}
    <div className="bot-memory-foot">
      {date && <time className="bot-memory-date" dateTime={entry.learnedAt} title={new Date(entry.learnedAt).toLocaleString()}>{date}</time>}
      {mode === 'view' && <span className="bot-memory-actions">
        {canEdit && <button type="button" onClick={() => { setMode('edit'); setError(null) }}>Edit</button>}
        <button type="button" onClick={() => { setMode('forget'); setError(null) }}>Forget</button>
        <button type="button" title={`Quote it in ${bot.name}'s chat`} onClick={() => store().askAboutMemory(bot.id, entry.text ?? '')}>{`Ask ${bot.name} about this`}</button>
      </span>}
      {mode === 'edit' && <span className="bot-memory-actions is-shown">
        <button type="button" disabled={busy} onClick={() => { setMode('view'); setError(null) }}>Cancel</button>
        <button type="button" className="is-strong" disabled={busy || !words.trim()} onClick={() => void save()}>Save</button>
      </span>}
      {mode === 'forget' && <span className="bot-memory-actions is-shown" role="group" aria-label="Forget this?">
        <span className="bot-memory-ask">Forget this?</span>
        <button type="button" disabled={busy} onClick={() => setMode('view')}>Cancel</button>
        <button type="button" className="is-danger" disabled={busy} onClick={() => void forget()}>Forget</button>
      </span>}
    </div>
    {error && <p className="bot-memory-error" role="alert">{error}</p>}
  </li>
}

function MemoryGroup({ bot, title, entries, focus, canEdit }: { bot: BotSummary; title: string; entries: BotMemoryEntry[]; focus?: string; canEdit: boolean }) {
  if (!entries.length) return null
  return <section className="bot-memory-group" aria-label={title}>
    <h3>{title} · {entries.length}</h3>
    <ul>{entries.map((entry) => <MemoryEntry key={entry.id} bot={bot} entry={entry} canEdit={canEdit} focused={Boolean(focus) && matches(entry, focus!)} />)}</ul>
  </section>
}

/**
 * A bot's memory in full: what the owner asked it to keep, then its own notes, newest first, each with its date.
 * Search narrows both. Each entry offers Edit, Forget (after a confirm) and Ask, which quotes it in the composer.
 */
export function BotMemoryDialog({ bot, focus }: { bot: BotSummary; focus?: string }) {
  const entries = useBotsStore((s) => s.memory[bot.id])
  const error = useBotsStore((s) => s.memoryError[bot.id])
  const canEdit = useBotsStore((s) => !s.memoryEditMissing)
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase()
    const all = [...(entries ?? NO_ENTRIES)].reverse()
    return memorySplit(words ? all.filter((entry) => (entry.text ?? '').toLowerCase().includes(words)) : all)
  }, [entries, query])
  // The entry a reply saved is shown first only until the owner searches.
  const target = query ? undefined : focus
  const none = !shown.wishes.length && !shown.notes.length
  return <BotDialogFrame title="Memory" onClose={() => useBotsStore.getState().closeMemory()} width={520}>
    <label className="bot-memory-search">
      <Search size={14} aria-hidden />
      <input type="search" aria-label="Search memory" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
    </label>
    <div className="bot-memory-list">
      <MemoryGroup bot={bot} title="Your wishes" entries={shown.wishes} focus={target} canEdit={canEdit} />
      <MemoryGroup bot={bot} title={`${bot.name}'s notes`} entries={shown.notes} focus={target} canEdit={canEdit} />
      {none && <p className="bot-about-empty bot-memory-empty">
        {!entries ? (error ?? 'Loading…') : query.trim() ? 'Nothing matches.' : 'Nothing yet. Tell it what to remember.'}
      </p>}
    </div>
  </BotDialogFrame>
}
