import { randomUUID } from 'node:crypto'
import type { BotTelling } from '../../../shared/bots/personal/telling'
import type { BotStore, BotMessageRow } from '../store/BotStore'
import type { BotChatProjection } from './projection'

/** Durable rows, transient banner presentation. Restarts reset sound counters. */
export class BotTellings {
  private windows = 0
  private catchup = false
  private readonly banners = new Map<string, BotMessageRow[]>()
  private fold: { id: string; until: number; rows: BotMessageRow[] } | undefined
  private readonly botSounds = new Map<string, number>()
  private profileSounds: number[] = []
  constructor(private readonly store: BotStore, private readonly chat: BotChatProjection,
    private readonly name: (id: string) => string, private readonly emit: (event: BotTelling) => void) {}

  attach(windows: number): void {
    if (windows && !this.windows) this.catchup = !!this.store.get('SELECT 1 FROM bot_messages WHERE tell IS NOT NULL AND told_at IS NULL LIMIT 1')
    this.windows = windows
  }
  read(): void {
    for (const [id, rows] of this.banners) {
      const unread = rows.filter(r => this.unread(r))
      if (unread.length === rows.length) continue
      if (unread.length) this.announce(unread, false, id)
      else { this.emit({ id, rows: [], title: '', body: '', kind: 'completed', sound: false }); this.banners.delete(id) }
    }
  }
  next(botId?: string, forTimer = false): number | undefined {
    if (!this.windows && forTimer) return undefined
    const row = this.store.get(`SELECT MIN(tell_at) AS at FROM bot_messages WHERE tell IS NOT NULL ${forTimer ? "AND tell != 'later'" : ''} AND told_at IS NULL${botId ? ' AND bot_id = ?' : ''}`, ...(botId ? [botId] : []))
    return typeof row?.at === 'string' ? Date.parse(row.at) : undefined
  }
  private unread(row: BotMessageRow): boolean {
    const bot = this.store.registry(row.botId)
    if (!bot || bot.deletedAt || row.seq <= bot.readSeq) return false
    const live = this.store.message(row.id)
    if (!live) return false
    const message = this.chat.toMessage(live)
    return (!message.ask || message.ask.status === 'open') && (!message.question || message.question.status === 'open')
  }
  release(now: number): void {
    if (!this.windows) return
    for (const [id, rows] of this.banners) if (rows.every(r => now - Date.parse(r.at) > 86_400_000)) this.banners.delete(id)
    const ids = this.store.all('SELECT id FROM bot_messages WHERE tell IS NOT NULL AND told_at IS NULL AND tell_at <= ? ORDER BY seq', new Date(now).toISOString())
    const due: BotMessageRow[] = []
    for (const { id } of ids) {
      const row = this.store.message(String(id))!
      if (!this.unread(row) || this.catchup && now - Date.parse(row.at) > 86_400_000) { this.told(row, now); continue }
      due.push(row)
    }
    if (this.catchup) {
      this.catchup = false
      if (due.some(r => r.tell !== 'later')) {
        this.announce(due, false, `bt_${randomUUID()}`, true)
        for (const row of due) this.told(row, now)
      }
      return
    }
    for (const row of due.filter(r => r.tell === 'now')) {
      this.announce([row], true)
      this.told(row, now)
    }
    const rest = due.filter(r => r.tell !== 'now')
    if (!rest.some(r => r.tell === 'soon')) return
    if (!this.fold || this.fold.until < now) this.fold = { id: `bt_${randomUUID()}`, until: now + 120_000, rows: [] }
    this.fold.rows = [...this.fold.rows.filter(r => this.unread(r)), ...rest]
    this.profileSounds = this.profileSounds.filter(at => now - at < 3600_000)
    const bots = [...new Set(rest.filter(r => r.tell === 'soon').map(r => r.botId))]
    const sounding = bots.filter(id => now - (this.botSounds.get(id) ?? -Infinity) >= 600_000)
    const sound = sounding.length > 0 && this.profileSounds.length < 6
    if (sound) { this.profileSounds.push(now); for (const id of sounding) this.botSounds.set(id, now) }
    this.announce(this.fold.rows, sound, this.fold.id)
    for (const row of rest) this.told(row, now)
  }
  private told(row: BotMessageRow, now: number): void {
    this.store.run('UPDATE bot_messages SET told_at = ? WHERE id = ? AND told_at IS NULL', new Date(now).toISOString(), row.id)
  }
  private announce(rows: BotMessageRow[], sound: boolean, id = `bt_${randomUUID()}`, closed = false): void {
    rows = rows.map(r => this.store.message(r.id)!).filter(Boolean)
    rows.sort((a, b) => Number(!!(b.askId || b.questionId || b.error)) - Number(!!(a.askId || a.questionId || a.error)) || a.seq - b.seq)
    const first = this.chat.toMessage(rows[0]!)
    const names = [...new Set(rows.map(r => this.name(r.botId)))]
    const line = (first.error?.text ?? (first.ask ? `Wants to ${first.ask.title}` : first.text)).split('\n').map(s => s.replace(/[*_`#>[\]]/g, '').trim()).find(Boolean) ?? 'New message'
    this.banners.set(id, rows)
    const summary = names.map(name => {
      const group = rows.filter(r => this.name(r.botId) === name)
      return group.some(r => r.askId || r.questionId || r.error) ? `${name} needs you` : `${name} ${group.length} messages`
    }).join(' · ')
    const title = closed ? `While Mousse was closed: ${summary}` : rows.length > 1 ? `${names.join(', ')} · ${rows.length} messages` : names[0]!
    this.emit({ id, rows: rows.map(r => ({ botId: r.botId, messageId: r.id, seq: r.seq, tell: r.tell! })), title, body: line.slice(0, 140), kind: first.ask || first.question ? 'question' : 'completed', sound })
  }
}
