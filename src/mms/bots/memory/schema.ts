/**
 * The memory tables of `bots.db` v4 (bot-context.md §3): the journal, its FTS index, memory
 * entries, their FTS index and the memory state. `BotStore`'s v4 migration runs this SQL after its
 * own statements, in the same transaction.
 * TODO(WP6): the real DDL. This placeholder lets the v4 migration land before WP6's tables.
 */
export const BOT_MEMORY_SCHEMA_SQL = ''
