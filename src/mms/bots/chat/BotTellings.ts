import { randomUUID } from 'node:crypto'
import type { BotTelling } from '../../../shared/bots/personal/telling'
import type { BotStore, BotMessageRow } from '../store/BotStore'
import type { BotChatProjection } from './projection'

/** Durable rows, transient banner presentation. Restarts reset sound counters. */
export class BotTellings {
  private windows = 0
  constructor(private readonly store: BotStore, private readonly chat: BotChatProjection,
    private readonly name: (id: string) => string, private readonly emit: (event: BotTelling) => void) {}

  attach(windows: number): void { this.windows = windows }
  next(botId?: string): number | undefined {
    if (!this.windows) return undefined
    const row = this.store.get(`SELECT MIN(tell_at) AS at FROM bot_messages WHERE tell IS NOT NULL AND tell != 'later' AND told_at IS NULL${botId ? ' AND bot_id = ?' : ''}`, ...(botId ? [botId] : []))
    return typeof row?.at === 'string' ? Date.parse(row.at) : undefined
  }
  private unread(row: BotMessageRow): boolean {
    const bot = this.store.registry(row.botId)
    if (!bot || bot.deletedAt || row.seq <= bot.readSeq) return false
    const message = this.chat.toMessage(row)
    return (!message.ask || message.ask.status === 'open') && (!message.question || message.question.status === 'open')
  }
  release(now: number): void {
    if (!this.windows) return
    const ids = this.store.all('SELECT id FROM bot_messages WHERE tell IS NOT NULL AND told_at IS NULL AND tell_at <= ? ORDER BY seq', new Date(now).toISOString())
    for (const { id } of ids) {
      const row = this.store.message(String(id))!
      if (!this.unread(row)) { this.told(row, now); continue }
      if (row.tell === 'later') continue
      this.announce([row], true)
      this.told(row, now)
    }
  }
  private told(row: BotMessageRow, now: number): void {
    this.store.run('UPDATE bot_messages SET told_at = ? WHERE id = ? AND told_at IS NULL', new Date(now).toISOString(), row.id)
  }
  private announce(rows: BotMessageRow[], sound: boolean): void {
    const first = this.chat.toMessage(rows[0]!)
    const line = (first.error?.text ?? (first.ask ? `Wants to ${first.ask.title}` : first.text)).split('\n').map(s => s.replace(/[*_`#>[\]]/g, '').trim()).find(Boolean) ?? 'New message'
    this.emit({ id: `bt_${randomUUID()}`, rows: rows.map(r => ({ botId: r.botId, messageId: r.id, seq: r.seq, tell: r.tell! })), title: this.name(rows[0]!.botId), body: line.slice(0, 140), kind: first.ask || first.question ? 'question' : 'completed', sound })
  }
}
