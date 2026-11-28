import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { NodeId } from '../../../shared/net'
import { sqliteFilePath } from '../../data/sqliteFilePath'
import type { RemoteBotMessage } from '../remote/RemoteBots'

/**
 * What this computer keeps of the bots of its other computers, and how much. Every cap is here, by name, so a reader
 * sees the whole bound in one place.
 */
export interface RemoteBotCopyLimits {
  /** Bots kept of one computer's feed; rows past it are not listed. */
  feedRows: number
  /** The copy of one computer's feed on disk, as JSON. A feed larger than this is not kept on disk at all. */
  feedBytes: number
  /** Messages kept of one bot's chat: its newest. */
  chatMessages: number
  /** One message, as JSON; a larger one is not kept. */
  messageBytes: number
  /** One bot's chat in all; its oldest messages go first. */
  chatBytes: number
  /**
   * Every chat of every computer together; the chats written least recently go first, whole, with the Bridge's copy of
   * their streams. A chat open here is never taken, so only chats open at once can hold the total over it.
   */
  totalChatBytes: number
}

export const REMOTE_BOT_COPY_LIMITS: Readonly<RemoteBotCopyLimits> = Object.freeze({
  feedRows: 500,
  feedBytes: 1024 * 1024,
  chatMessages: 200,
  // A stream record carries at most 56 KiB of message (`fittedBotMessage`).
  messageBytes: 64 * 1024,
  chatBytes: 2 * 1024 * 1024,
  totalChatBytes: 16 * 1024 * 1024
})

/** One bot's chat: its computer, and its id there. */
export interface ChatRef {
  node: NodeId
  bot: string
}

export interface CachedBotFeed {
  node: NodeId
  savedAt: number
  /** The bots feed snapshot as the other computer sent it (rows cut to `feedRows`), as JSON text. */
  snapshot: string
}

/** The profile's copy of other computers' bots, its own file: `<profile>/bots/other-computers.db`. */
export const REMOTE_BOTS_DB = 'other-computers.db'

const SCHEMA = [
  'PRAGMA busy_timeout=5000',
  'PRAGMA journal_mode=WAL',
  'PRAGMA synchronous=NORMAL',
  'CREATE TABLE IF NOT EXISTS remote_bot_feeds(node TEXT PRIMARY KEY,saved_at INTEGER NOT NULL,snapshot TEXT NOT NULL) STRICT',
  'CREATE TABLE IF NOT EXISTS remote_bot_chats(node TEXT NOT NULL,bot TEXT NOT NULL,used_at INTEGER NOT NULL,PRIMARY KEY(node,bot)) STRICT',
  'CREATE TABLE IF NOT EXISTS remote_bot_messages(node TEXT NOT NULL,bot TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,bytes INTEGER NOT NULL,message TEXT NOT NULL,PRIMARY KEY(node,bot,id)) STRICT',
  'CREATE INDEX IF NOT EXISTS remote_bot_messages_seq ON remote_bot_messages(node,bot,seq)'
].join(';')

/**
 * The copy on disk of the bots of the user's other computers, kept by the viewing computer only and never sent
 * anywhere: each computer's last bots feed (`RemoteBotRegistry`), and the newest messages of the chats opened here
 * (`RemoteBotChats`), text and card data only. Display-only notes (a live chip, a reply as it is written) are never
 * written. It is a file of its own, apart from `net.db`, opened on first use so nothing waits for it at start.
 *
 * A write can fail (a full disk); the caller treats that as best effort and keeps what it holds in memory. A drop is
 * the one write that must hold: it is never deferred.
 */
export class SqliteRemoteBots {
  private opened?: DatabaseSync
  private closed = false
  readonly limits: RemoteBotCopyLimits

  constructor(
    readonly path: string,
    private readonly clock: { now(): number } = Date,
    limits: Partial<RemoteBotCopyLimits> = {}
  ) {
    this.limits = { ...REMOTE_BOT_COPY_LIMITS, ...limits }
  }

  private get db(): DatabaseSync {
    if (this.closed) throw new Error('The copy of other computers’ bots is closed.')
    if (this.opened) return this.opened
    mkdirSync(dirname(this.path), { recursive: true })
    const db = new DatabaseSync(sqliteFilePath(this.path))
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // Windows: the profile folder's own rights hold.
    }
    db.exec(SCHEMA)
    this.opened = db
    return db
  }

  private transaction<T>(work: (db: DatabaseSync) => T): T {
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = work(db)
      db.exec('COMMIT')
      return out
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The transaction already ended.
      }
      throw error
    }
  }

  /** Whether there is a copy to read: the file is open, or on disk from before. Never creates it. */
  exists(): boolean {
    return !!this.opened || existsSync(this.path)
  }

  close(): void {
    this.closed = true
    try {
      this.opened?.close()
    } catch {
      // Already closed.
    }
    this.opened = undefined
  }

  // ------------------------------------------------------------------ feeds

  feeds(): CachedBotFeed[] {
    return this.db
      .prepare('SELECT node,saved_at,snapshot FROM remote_bot_feeds')
      .all()
      .map((row) => ({ node: String(row.node) as NodeId, savedAt: Number(row.saved_at), snapshot: String(row.snapshot) }))
  }

  feed(node: NodeId): CachedBotFeed | undefined {
    const row = this.db.prepare('SELECT node,saved_at,snapshot FROM remote_bot_feeds WHERE node=?').get(node)
    return row ? { node, savedAt: Number(row.saved_at), snapshot: String(row.snapshot) } : undefined
  }

  /**
   * Keeps `snapshot` as the copy of `node`'s feed, and with it drops the chats of the bots it no longer has (`bots`).
   * A feed over `feedBytes` is not kept at all: an older copy would list bots this computer may have lost since.
   */
  saveFeed(node: NodeId, snapshot: string, bots: ReadonlySet<string>): void {
    const fits = Buffer.byteLength(snapshot) <= this.limits.feedBytes
    this.transaction((db) => {
      if (fits)
        db.prepare(
          'INSERT INTO remote_bot_feeds(node,saved_at,snapshot) VALUES(?,?,?) ON CONFLICT(node) DO UPDATE SET saved_at=excluded.saved_at, snapshot=excluded.snapshot'
        ).run(node, this.clock.now(), snapshot)
      else db.prepare('DELETE FROM remote_bot_feeds WHERE node=?').run(node)
      this.dropChatsNotIn(db, node, bots)
    })
  }

  // ------------------------------------------------------------------ chats

  /** The copy of a bot's chat, oldest first. */
  messages(node: NodeId, bot: string): RemoteBotMessage[] {
    return this.db
      .prepare('SELECT message FROM remote_bot_messages WHERE node=? AND bot=? ORDER BY seq ASC')
      .all(node, bot)
      .map((row) => JSON.parse(String(row.message)) as RemoteBotMessage)
  }

  /** The chats kept, with their size, for the Devices screens and the tests. */
  chats(): Array<{ node: NodeId; bot: string; messages: number; bytes: number }> {
    return this.db
      .prepare(
        'SELECT c.node AS node,c.bot AS bot,count(m.id) AS messages,coalesce(sum(m.bytes),0) AS bytes FROM remote_bot_chats c LEFT JOIN remote_bot_messages m ON m.node=c.node AND m.bot=c.bot GROUP BY c.node,c.bot'
      )
      .all()
      .map((row) => ({ node: String(row.node) as NodeId, bot: String(row.bot), messages: Number(row.messages), bytes: Number(row.bytes) }))
  }

  /**
   * The chat as the bot's computer has it now (a stream's snapshot): it takes the place of the copy. Returns the other
   * chats the total cap took (never one in `open`).
   */
  replaceChat(node: NodeId, bot: string, messages: readonly RemoteBotMessage[], open: readonly ChatRef[] = []): ChatRef[] {
    return this.transaction((db) => {
      db.prepare('DELETE FROM remote_bot_messages WHERE node=? AND bot=?').run(node, bot)
      this.touch(db, node, bot)
      const write = this.writer(db)
      // Newest first, so the caps keep the newest.
      const sorted = [...messages].sort((a, b) => b.seq - a.seq).slice(0, this.limits.chatMessages)
      for (const message of sorted) write(node, bot, message)
      return this.trim(db, node, bot, open)
    })
  }

  /** A message added or changed in the chat. Returns the other chats the total cap took (never one in `open`). */
  putMessage(node: NodeId, bot: string, message: RemoteBotMessage, open: readonly ChatRef[] = []): ChatRef[] {
    return this.transaction((db) => {
      this.touch(db, node, bot)
      this.writer(db)(node, bot, message)
      return this.trim(db, node, bot, open)
    })
  }

  dropChat(node: NodeId, bot: string): void {
    this.transaction((db) => {
      db.prepare('DELETE FROM remote_bot_messages WHERE node=? AND bot=?').run(node, bot)
      db.prepare('DELETE FROM remote_bot_chats WHERE node=? AND bot=?').run(node, bot)
    })
  }

  // ------------------------------------------------------------------ computers

  /** Forgets everything kept of a computer's bots: its feed and every chat. */
  dropComputer(node: NodeId): void {
    this.transaction((db) => {
      for (const table of ['remote_bot_feeds', 'remote_bot_chats', 'remote_bot_messages'])
        db.prepare(`DELETE FROM ${table} WHERE node=?`).run(node)
    })
  }

  /** Forgets everything kept of the computers `keep` says no to (they left the user's computers, or were blocked). */
  dropOthers(keep: (node: NodeId) => boolean): NodeId[] {
    const known = new Set<NodeId>()
    for (const table of ['remote_bot_feeds', 'remote_bot_chats', 'remote_bot_messages'])
      for (const row of this.db.prepare(`SELECT DISTINCT node FROM ${table}`).all()) known.add(String(row.node) as NodeId)
    const dropped = [...known].filter((node) => !keep(node))
    for (const node of dropped) this.dropComputer(node)
    return dropped
  }

  // ------------------------------------------------------------------ inside

  private dropChatsNotIn(db: DatabaseSync, node: NodeId, bots: ReadonlySet<string>): void {
    const kept = db.prepare('SELECT bot FROM remote_bot_chats WHERE node=? UNION SELECT DISTINCT bot FROM remote_bot_messages WHERE node=?').all(node, node)
    for (const row of kept) {
      const bot = String(row.bot)
      if (bots.has(bot)) continue
      db.prepare('DELETE FROM remote_bot_messages WHERE node=? AND bot=?').run(node, bot)
      db.prepare('DELETE FROM remote_bot_chats WHERE node=? AND bot=?').run(node, bot)
    }
  }

  private touch(db: DatabaseSync, node: NodeId, bot: string): void {
    db.prepare(
      'INSERT INTO remote_bot_chats(node,bot,used_at) VALUES(?,?,?) ON CONFLICT(node,bot) DO UPDATE SET used_at=excluded.used_at'
    ).run(node, bot, this.clock.now())
  }

  private writer(db: DatabaseSync) {
    const insert = db.prepare(
      'INSERT INTO remote_bot_messages(node,bot,id,seq,bytes,message) VALUES(?,?,?,?,?,?) ON CONFLICT(node,bot,id) DO UPDATE SET seq=excluded.seq, bytes=excluded.bytes, message=excluded.message'
    )
    // A chat row as the bot's computer sent it (`remoteBotMessage`): its text, cards and other data. Files in it are
    // named only, never their bytes, so no file or picture is copied here.
    return (node: NodeId, bot: string, message: RemoteBotMessage): void => {
      const text = JSON.stringify(message)
      const bytes = Buffer.byteLength(text)
      if (bytes > this.limits.messageBytes) return
      insert.run(node, bot, message.id, message.seq, bytes, text)
    }
  }

  /**
   * Holds the caps: the bot's newest `chatMessages` within `chatBytes`, then every chat within `totalChatBytes`.
   * Returns the chats the total took.
   */
  private trim(db: DatabaseSync, node: NodeId, bot: string, open: readonly ChatRef[]): ChatRef[] {
    db.prepare(
      'DELETE FROM remote_bot_messages WHERE node=? AND bot=? AND id NOT IN (SELECT id FROM remote_bot_messages WHERE node=? AND bot=? ORDER BY seq DESC LIMIT ?)'
    ).run(node, bot, node, bot, this.limits.chatMessages)
    const sizeOf = (sql: string, ...params: Array<string | number>): number => Number(db.prepare(sql).get(...params)?.bytes ?? 0)
    let chat = sizeOf('SELECT coalesce(sum(bytes),0) AS bytes FROM remote_bot_messages WHERE node=? AND bot=?', node, bot)
    if (chat > this.limits.chatBytes) {
      const oldest = db.prepare('SELECT id,bytes FROM remote_bot_messages WHERE node=? AND bot=? ORDER BY seq ASC').all(node, bot)
      const remove = db.prepare('DELETE FROM remote_bot_messages WHERE node=? AND bot=? AND id=?')
      for (const row of oldest) {
        if (chat <= this.limits.chatBytes) break
        remove.run(node, bot, String(row.id))
        chat -= Number(row.bytes)
      }
    }
    let total = sizeOf('SELECT coalesce(sum(bytes),0) AS bytes FROM remote_bot_messages')
    const dropped: ChatRef[] = []
    if (total <= this.limits.totalChatBytes) return dropped
    // The chats written least recently go first, whole; never the one being written, nor one open here.
    const kept = new Set(open.map((chat) => `${chat.node}\u0000${chat.bot}`))
    const others = db
      .prepare('SELECT node,bot FROM remote_bot_chats WHERE NOT (node=? AND bot=?) ORDER BY used_at ASC')
      .all(node, bot)
    for (const row of others) {
      if (total <= this.limits.totalChatBytes) break
      const other = { node: String(row.node) as NodeId, bot: String(row.bot) }
      if (kept.has(`${other.node}\u0000${other.bot}`)) continue
      const size = sizeOf('SELECT coalesce(sum(bytes),0) AS bytes FROM remote_bot_messages WHERE node=? AND bot=?', other.node, other.bot)
      db.prepare('DELETE FROM remote_bot_messages WHERE node=? AND bot=?').run(other.node, other.bot)
      db.prepare('DELETE FROM remote_bot_chats WHERE node=? AND bot=?').run(other.node, other.bot)
      total -= size
      dropped.push(other)
    }
    return dropped
  }
}
