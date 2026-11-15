import type { BotChatMessage } from '../../../shared/bots/personal/chat'
import { botNotificationContent, botNotificationKind } from '../../../shared/bots/personal/notification'
import { randomUUID } from 'node:crypto'
import type { BotTelling } from '../../../shared/bots/personal/telling'
import type { BotStore, BotMessageRow } from '../store/BotStore'
import type { BotChatProjection } from './projection'

/** Durable rows, transient banner presentation. Restarts reset sound counters. */
export class BotTellings {
  private readonly retryAt = new Map<string, number>()
  private windows = 0
  private closedThrough = 0
  private readonly banners = new Map<string, BotMessageRow[]>()
  private fold: { id: string; until: number; rows: BotMessageRow[] } | undefined
  private readonly botSounds = new Map<string, number>()
  private profileSounds: number[] = []
  constructor(private readonly store: BotStore, private readonly chat: BotChatProjection,
    private readonly name: (id: string) => string, private readonly emit: (event: BotTelling) => void,
    private readonly retryMs = 60_000) {}

  attach(windows: number): void {
    if (windows && !this.windows) this.closedThrough = Number(this.store.get(`SELECT MAX(seq) AS seq FROM bot_messages
      WHERE tell IS NOT NULL AND tell != 'later' AND told_at IS NULL`)?.seq ?? 0)
    this.windows = windows
  }
  /** A successful legacy message push with no capable audience is a durable handoff receipt, not a release. */
  noteLegacy(botId: string, message: BotChatMessage, quiet: boolean): void {
    if (this.windows || quiet || !botNotificationKind(message, Date.parse(this.store.now()))) return
    const row = this.store.message(message.id)
    if (!row || row.botId !== botId || !row.tell || row.toldAt) return
    this.store.run(`INSERT INTO bot_memory_state(bot_id, key, value) VALUES(?, ?, 'true') ON CONFLICT DO NOTHING`,
      botId, `cursor:telling-legacy:${message.id}`)
  }
  read(): void {
    for (const [id, rows] of this.banners) {
      if (rows.some(r => this.unread(r))) continue
      const now = Date.parse(this.store.now())
      if (rows.some(r => (this.retryAt.get(r.botId) ?? 0) > now)) continue
      this.attempt(rows, now, () => {
        this.emit({ id, rows: [], title: '', body: '', kind: 'completed', sound: false })
        this.banners.delete(id)
      })
    }
  }
  next(botId?: string): number | undefined {
    if (!this.windows) return undefined
    const rows = this.store.all(`SELECT bot_id, MIN(tell_at) AS at FROM bot_messages
      WHERE tell IS NOT NULL AND tell != 'later' AND told_at IS NULL${botId ? ' AND bot_id = ?' : ''} GROUP BY bot_id`, ...(botId ? [botId] : []))
    const times = rows.map(row => Math.max(Date.parse(String(row.at)), this.retryAt.get(String(row.bot_id)) ?? 0))
    return times.length ? Math.min(...times) : undefined
  }
  private attempt(rows: BotMessageRow[], now: number, run: () => void): boolean {
    try {
      run()
      for (const row of rows) this.retryAt.delete(row.botId)
      return true
    } catch {
      for (const row of rows) this.retryAt.set(row.botId, now + this.retryMs)
      return false
    }
  }

  private unread(row: BotMessageRow): boolean {
    const bot = this.store.registry(row.botId)
    if (!bot || bot.deletedAt || row.seq <= bot.readSeq) return false
    if (this.store.get('SELECT 1 FROM bot_memory_state WHERE bot_id = ? AND key = ?', row.botId, `cursor:telling-legacy:${row.id}`)) return false
    const live = this.store.message(row.id)
    if (!live) return false
    const message = this.chat.toMessage(live)
    return (!message.ask || message.ask.status === 'open') && (!message.question || message.question.status === 'open')
  }
  release(now: number): void {
    // One bulk maintenance transaction, including on legacy-only profiles. A receipt's message
    // age is sufficient: messages outside the same day are never caught up, and missing rows keep no receipt.
    try {
      this.store.db.transaction(() => {
        const cutoff = new Date(now - 86_400_000).toISOString()
        this.store.run(`UPDATE bot_messages INDEXED BY bot_messages_tell_due SET told_at = ?
          WHERE tell IS NOT NULL AND told_at IS NULL AND tell = 'later' AND at <= ?`, new Date(now).toISOString(), cutoff)
        this.store.run(`DELETE FROM bot_memory_state AS s WHERE s.key GLOB 'cursor:telling-legacy:*'
          AND NOT EXISTS (SELECT 1 FROM bot_messages m WHERE m.bot_id = s.bot_id
            AND s.key = 'cursor:telling-legacy:' || m.id AND m.at > ?)`, cutoff)
      })
    } catch { /* The next upkeep pass retries expiration; it never arms the due timer. */ }
    if (!this.windows) return
    for (const [id, rows] of this.banners) if (rows.every(r => now - Date.parse(r.at) > 86_400_000)) this.banners.delete(id)
    const ids = this.store.all(`SELECT id FROM bot_messages INDEXED BY bot_messages_tell_due WHERE tell IS NOT NULL AND tell != 'later' AND told_at IS NULL AND tell_at <= ? ORDER BY seq`, new Date(now).toISOString())
    const due: BotMessageRow[] = []
    for (const { id } of ids) {
      const row = this.store.message(String(id))!
      if ((this.retryAt.get(row.botId) ?? 0) > now) continue
      if (!this.unread(row) || row.seq <= this.closedThrough && now - Date.parse(row.at) > 86_400_000) { this.attempt([row], now, () => this.told(row, now)); continue }
      due.push(row)
    }
    // Only project later rows if this release can count them in a fold.
    if (due.some(r => r.tell === 'soon') || due.some(r => r.seq <= this.closedThrough)) {
      for (const { id } of this.store.all(`SELECT id FROM bot_messages INDEXED BY bot_messages_tell_due
        WHERE tell IS NOT NULL AND tell = 'later' AND told_at IS NULL AND tell_at <= ? ORDER BY seq`, new Date(now).toISOString())) {
        const row = this.store.message(String(id))!
        if ((this.retryAt.get(row.botId) ?? 0) <= now) due.push(row)
      }
    }
    const held = (r: BotMessageRow): boolean => r.tell === 'soon' && !!r.tellAt && r.tellAt > r.at
    const closed = due.filter(r => (r.seq <= this.closedThrough || held(r)) && r.tell !== 'later')
    if (closed.length) {
      closed.push(...due.filter(r => r.tell === 'later' && (r.seq <= this.closedThrough || closed.some(held))))
      if (!this.attempt(closed, now, () => this.releaseBacklog(closed, now, closed.some(held) ? 'While you were away' : 'While Mousse was closed'))) {
        for (const bot of new Set(closed.map(r => r.botId))) {
          const rows = closed.filter(r => r.botId === bot)
          if (rows.some(r => r.tell !== 'later')) this.attempt(rows, now, () => this.releaseBacklog(rows, now, rows.some(held) ? 'While you were away' : 'While Mousse was closed'))
        }
      }
    }
    const closedIds = new Set(closed.map(r => r.id))
    const live = due.filter(r => !closedIds.has(r.id))
    for (const row of live.filter(r => r.tell === 'now')) {
      this.attempt([row], now, () => { this.announce([row], true); this.told(row, now) })
    }
    const rest = live.filter(r => r.tell !== 'now')
    if (!rest.some(r => r.tell === 'soon')) return
    for (const bot of new Set(rest.filter(r => r.tell === 'soon').map(r => r.botId))) {
      const rows = rest.filter(r => r.botId === bot || r.tell === 'later' && !this.store.message(r.id)?.toldAt && (this.retryAt.get(r.botId) ?? 0) <= now)
      const previous = this.fold
      if (!this.attempt(rows, now, () => {
        const base = previous && previous.until >= now ? previous : { id: `bt_${randomUUID()}`, until: now + 120_000, rows: [] }
        this.fold = { ...base, rows: [...base.rows.filter(r => this.unread(r) && (this.retryAt.get(r.botId) ?? 0) <= now), ...rows] }
        this.profileSounds = this.profileSounds.filter(at => now - at < 3600_000)
        const sound = now - (this.botSounds.get(bot) ?? -Infinity) >= 600_000 && this.profileSounds.length < 6
        if (sound) { this.profileSounds.push(now); this.botSounds.set(bot, now) }
        this.announce(this.fold.rows, sound, this.fold.id)
        for (const row of rows) this.told(row, now)
      })) this.fold = previous
    }
  }
  /** A held backlog is released as one fold; usable for future quiet-hour release too. */
  releaseBacklog(rows: BotMessageRow[], now: number, label = 'While Mousse was closed'): void {
    this.announce(rows, false, `bt_${randomUUID()}`, label)
    for (const row of rows) this.told(row, now)
  }

  private told(row: BotMessageRow, now: number): void {
    this.store.db.transaction(() => {
      this.store.run('UPDATE bot_messages SET told_at = ? WHERE id = ? AND told_at IS NULL', new Date(now).toISOString(), row.id)
      this.store.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?', row.botId, `cursor:telling-legacy:${row.id}`)
    })
  }
  private announce(rows: BotMessageRow[], sound: boolean, id = `bt_${randomUUID()}`, closed: false | string = false): void {
    rows = rows.map(r => this.store.message(r.id)!).filter(Boolean)
    const priority = (row: BotMessageRow): number => row.tell === 'later' ? 0 : row.askId || row.questionId || row.error ? 2 : 1
    rows.sort((a, b) => priority(b) - priority(a) || a.seq - b.seq)
    const first = this.chat.toMessage(rows[0]!)
    const names = [...new Set(rows.map(r => this.name(r.botId)))]
    const { body } = botNotificationContent(this.name(rows[0]!.botId), first)
    const summary = names.map(name => {
      const group = rows.filter(r => this.name(r.botId) === name)
      return group.some(r => r.askId || r.questionId || r.error) ? `${name} needs you` : `${name} ${group.length} ${closed === 'While you were away' ? group.length === 1 ? 'update' : 'updates' : group.length === 1 ? 'message' : 'messages'}`
    }).join(' · ')
    const title = rows.length === 1 && closed !== 'While you were away' ? names[0]! : closed ? `${closed}: ${summary}` : `${names.join(', ')} · ${rows.length} messages`
    this.emit({ id, rows: rows.map(r => ({ botId: r.botId, messageId: r.id, seq: r.seq, tell: r.tell! })), title, body, kind: first.ask || first.question ? 'question' : 'completed', sound })
    this.banners.set(id, rows)
  }
}
