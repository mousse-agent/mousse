/**
 * Bot memory's tables in `bots.db` (docs/plans/bot-context.md §3), run by WP2's v4 migration after
 * its own statements. `BotMemoryStore` is the only module that reads or writes them.
 *
 * - `bot_journal`: the append-only record of everything Mousse observed of a bot. Rows are never
 *   deleted except by the 30-day purge; a forget redacts a row's text in place.
 * - `bot_journal_fts`: an external-content FTS5 index over the journal, kept in step by triggers in
 *   the writer's transaction, and rebuildable (`'rebuild'`).
 * - `bot_memories`: memory entries, one row per version; a forgotten entry keeps its hash only.
 * - `bot_memories_fts`: an FTS5 index over memory versions that still have text.
 * - `bot_memory_state`: the chat summary, the window start, capture cursors, frozen packs, stats.
 *
 * Deviations from the plan's sketch, both for durability: `bot_journal.keys` exists because an
 * external-content index reads every indexed column back from its content table, and
 * `bot_memories` has an explicit integer key, since `VACUUM` may renumber an implicit rowid and the
 * memory index refers to it.
 */
export const BOT_MEMORY_SCHEMA_SQL = `
CREATE TABLE bot_journal(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('owner_msg','bot_msg','run_start','run_report','run_end',
    'tool_call','tool_result','ask','answer','memory_op','model_change','redaction','notice')),
  lane TEXT CHECK(lane IS NULL OR lane IN ('chat','run')),
  activation_id TEXT,
  thread_id TEXT,
  source_key TEXT NOT NULL,
  who TEXT NOT NULL CHECK(who IN ('owner','bot','tool','mousse')),
  external INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  keys TEXT NOT NULL DEFAULT '',
  json TEXT,
  redacted_at TEXT,
  UNIQUE(bot_id, source_key)
) STRICT;
CREATE INDEX bot_journal_bot ON bot_journal(bot_id, seq);
CREATE INDEX bot_journal_activation ON bot_journal(activation_id, seq);
CREATE INDEX bot_journal_kind ON bot_journal(bot_id, kind, seq);

CREATE VIRTUAL TABLE bot_journal_fts USING fts5(
  text, keys, content='bot_journal', content_rowid='seq',
  tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER bot_journal_fts_insert AFTER INSERT ON bot_journal BEGIN
  INSERT INTO bot_journal_fts(rowid, text, keys) VALUES(new.seq, new.text, new.keys);
END;
CREATE TRIGGER bot_journal_fts_delete AFTER DELETE ON bot_journal BEGIN
  INSERT INTO bot_journal_fts(bot_journal_fts, rowid, text, keys) VALUES('delete', old.seq, old.text, old.keys);
END;
CREATE TRIGGER bot_journal_fts_update AFTER UPDATE OF text, keys ON bot_journal BEGIN
  INSERT INTO bot_journal_fts(bot_journal_fts, rowid, text, keys) VALUES('delete', old.seq, old.text, old.keys);
  INSERT INTO bot_journal_fts(rowid, text, keys) VALUES(new.seq, new.text, new.keys);
END;

CREATE TABLE bot_memories(
  row_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('owner','note','run_note')),
  text TEXT,
  text_hash TEXT NOT NULL,
  learned_at TEXT NOT NULL,
  valid_from TEXT,
  expires_at TEXT,
  written_in TEXT NOT NULL CHECK(written_in IN ('chat','run','owner_ui','dream')),
  source_seq INTEGER,
  status TEXT NOT NULL CHECK(status IN ('active','superseded','expired','forgotten')),
  reason TEXT,
  UNIQUE(bot_id, id, version)
) STRICT;
CREATE INDEX bot_memories_current ON bot_memories(bot_id, status, kind);
CREATE INDEX bot_memories_hash ON bot_memories(bot_id, text_hash);

CREATE VIRTUAL TABLE bot_memories_fts USING fts5(
  text, bot_id UNINDEXED, mem_id UNINDEXED,
  tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER bot_memories_fts_insert AFTER INSERT ON bot_memories WHEN new.text IS NOT NULL BEGIN
  INSERT INTO bot_memories_fts(rowid, text, bot_id, mem_id) VALUES(new.row_id, new.text, new.bot_id, new.id);
END;
CREATE TRIGGER bot_memories_fts_delete AFTER DELETE ON bot_memories BEGIN
  DELETE FROM bot_memories_fts WHERE rowid = old.row_id;
END;
CREATE TRIGGER bot_memories_fts_update AFTER UPDATE OF text ON bot_memories BEGIN
  DELETE FROM bot_memories_fts WHERE rowid = old.row_id;
  INSERT INTO bot_memories_fts(rowid, text, bot_id, mem_id) SELECT new.row_id, new.text, new.bot_id, new.id WHERE new.text IS NOT NULL;
END;

CREATE TABLE bot_memory_state(
  bot_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(bot_id, key)
) STRICT;
`

/** The name the architecture plan uses (bot-architecture.md §5.1.2). */
export const BOT_MEMORY_SCHEMA_V4 = BOT_MEMORY_SCHEMA_SQL
