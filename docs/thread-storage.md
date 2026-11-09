# Thread storage

Each thread keeps its history in one SQLite database, `thread.db`, inside the thread's folder (`<profile>/thread-data/{standalone,repositories/<project>}/<thread>/`). Trash, restore, purge, retirement, copies between computers and backups still move whole folders, and deleting a thread's folder frees all of its space at once.

Threads made before this keep their JSON files until they are imported (see [Moving a thread from JSON](#moving-a-thread-from-json)). While the `sqliteThreadStore` feature is off, new threads still start on JSON; a thread that already has a `thread.db` always uses it.

## What a thread database holds

Every message is stored once, as one row, in the collection it belongs to:

| Collection | What it is |
|---|---|
| `m` | the transcript: what people see (`ChatMessage`) |
| `c:a`, `c:r` | the model context: what the model is sent (`NativeLlmContext.messages` and `.retiredMessages`) |
| `s:<n>:m`, `s:<n>:h`, `s:<n>:ca`, `s:<n>:cr` | the same for in-app subagent session `n` (its timeline, its history, its context) |

The transcript and the model context are two records on purpose: after compaction or an undo they differ. Neither is a copy of the other, and nothing else holds them.

Small values live in `state`: `agents`, `tasks`, `context` (the model context without its message lists) and `sessions` (subagent session headers without theirs). `info` holds the change counter `seq`, an `epoch`, the database's own id, and, for an imported thread, a fingerprint of the JSON files it came from.

```
items(rid, coll, ord, msg_id, role, kind, ts, rev, changed_seq, payload, blob_paths)
state(key, rev, changed_seq, payload)
removed(rid, coll, changed_seq)
info(key, value)
```

- `rid` is a row's identity. It never changes while the row exists.
- `ord` orders a collection. Rows are spaced 1,024 apart, so a message inserted between two others takes a number between theirs and nothing else moves. Only when there is no room left is the collection renumbered, and `epoch` goes up.
- Every save is one transaction that raises `seq` by one and stamps the rows it changed with it (`changed_seq`). "What changed since N" is an index range: the changed rows, plus the `removed` records (kept back to a horizon; a reader older than that starts over).

What stays a file: `meta.json` (the thread's identity, read by lifecycle code without opening a database), `queue.json` and its journal (the queue's own lock and durability contract), the operation `journal/`, `workspace.json`, `actions.json`, `conversation-branches.json` and terminal scrollback.

## Images and large outputs

Image data (`images[].data` in messages, image parts of the model context) and any text longer than 64 KiB are kept outside the rows, in the thread's `blobs/` folder: one file per SHA-256 of the content, so the same image in two messages is stored once, and deleting the thread's folder frees them. Image data that is exact base64 is stored as its decoded bytes.

A row that refers to blobs lists them in its `blob_paths` column: for each, the exact path in the row's JSON, the hash, the size and how it is stored. The payload holds an empty string there. That list is the only thing that marks a value as a blob, so an ordinary value can never be read as one.

- A save writes and fsyncs its blobs before the transaction that commits the rows referring to them.
- Reading a row puts its blobs back and checks each one's hash. A missing or damaged blob shows as `[attachment unavailable: blob <kind>:<hash>]` and the thread still opens. The placeholder names its blob, so a later save that still holds it, wherever the value moved to (the row too), writes the reference back instead of the placeholder. An image whose bytes are missing is sent to the model as the note `[image unavailable]`, never as image data.
- Writing a blob that is already there checks the copy's hash and replaces a damaged one, and fsyncs it and its folders either way, so a copy another writer has just made is durable before a row that refers to it commits.
- Text that UTF-8 cannot hold exactly (a lone surrogate) stays in its row. New blob folders are fsynced into their parents before rows that refer to them commit, and collection never removes a folder that is not empty.
- When a save removes or rewrites a row that had blobs, and on a thread's first save each hour (a save that changes nothing included), blobs no row refers to any more are deleted, once they are an hour old. Saves and collection both run under the thread's lock, and the hour keeps a blob another process has just written for a save it has not committed yet. An import writes its blobs into a staging folder of its own, `thread.db.import-<pid>-<id>.stage`, never into `blobs/`; they move into `blobs/` under the lock just before the database is linked into place, and an import that fails or finds its source changed removes its staging folder.

## Saving only what changed

The daemon keeps, for each thread it uses, what it last wrote: per row its `rid`, its `ord` and a skeleton of its value (objects and arrays copied, strings shared with the value, since JavaScript strings never change). A save walks the thread it is given and compares each message with its skeleton. Text that did not change is the same string, so comparing it costs nothing; the walk costs a step per field, not per byte, and finds every change, however it was made. Only the rows that differ are serialized and written.

A message keeps its row when it is edited in place, replaced by a new object (the n-th message with an id claims the n-th row with that id), or moved by a removal elsewhere. Context messages, which have no id, keep the row at their position. A row another process added since this process last looked is never removed by a save that did not include it, and is taken for a message with the same id only when it holds the same message. What a list held is remembered compactly: the highest row id it held and the few rows below that it did not, shared by the list and every object saved in it, so a long session's memory and an unchanged save stay linear in the thread.

A save keeps the contract it always had: when it returns, the change is on disk; if it fails, it throws, and the daemon's copy still describes what is on disk.

Each save still moves the thread's `updatedAt`. For a thread in `thread.db` that happens in memory at once; `meta.json` and the standalone index are rewritten when the thread starts, at most every 30 seconds after that, and at shutdown.

## Where the work runs

All database work runs in two worker threads (`src/mms/data/threadDb/`), never on the daemon's event loop:

- **The write worker** runs saves and the few small reads a save needs. The caller waits for its reply synchronously, which is what keeps "saved before the next step" true for queue admission, steering, handoffs and every other place that depends on it. A save writes only the rows that changed, so the wait does not grow with the thread. It keeps one connection per thread and closes it after 2 seconds idle.
- **The read worker** runs everything whose cost grows with a thread or with the profile: loading a whole thread, importing and checking, and later pages, search and exports. Nothing waits for it synchronously, and a long read never delays a save. It opens a connection per request and closes it afterwards, so it never holds a read open between requests.

Entry points that are about to load a thread (`thread.snapshot`, `thread.messages`) read it in the read worker first, so the synchronous load that follows finds it in memory.

Connections are opened only for a database that exists and are checked against the file's inode on every use, so a moved or deleted folder is never recreated empty. Before a thread's folder is moved or purged, the lifecycle code closes this process's connections (`quiesceDisk`), which checkpoints the WAL; SQLite removes the WAL itself on the last close.

The worker is built as one self-contained file beside each bundle (`out/cli/threadDbWorker.js`, `out/main/threadDbWorker.js`) and unpacked in packaged builds. Tests that run from source use the same engine in-process.

## Search

`<profile>/thread-index.db` holds the transcript text of every thread kept in `thread.db`, lowercased by JavaScript, with a case-sensitive FTS5 trigram index over it, so search matches exactly as `toLowerCase().includes()` always did, for every alphabet. It is a cache: the app never treats it as the record of anything.

- It runs in the read worker, which handles requests in order.
- **A save, then a search.** After a save, the daemon sends an index notice within a second, or right before the next search. The worker applies the notice before answering, so a search finds what was saved before it.
- **Writes from elsewhere.** Before answering, a search also catches up any candidate thread whose database files (inode, size and time) changed since it was indexed, for example written by another process. That check costs a `stat` per thread. The minute sweep also compares each database's own sequence, so a write the file stamp did not show (the same inode, size and time after a checkpoint) is caught there, within a minute; checking every database's sequence on every search would cost a database open per thread.
- **The sweep.** It runs at startup and every minute. It catches up changed threads and drops threads that are no longer listed.
- **Rebuilding.** Missing or outdated tables are recreated inside the index, in one transaction. A file that is not a database or is damaged is set aside and a new one made. A busy or locked index is never taken for damage. A thread whose database was replaced or renumbered is indexed again from scratch.
- **When the index cannot answer** (damaged, or busy and so unable to catch a thread up), search reads each thread's transcript in the read worker instead, until it has enough distinct results, so a broken cache never breaks search or answers from stale rows.
- **Results** come in the threads' name order and then transcript order, and the index is asked for more until the limit is filled after repeats are removed. Lifecycle state is checked for every thread on every search; only the folder lookup is cached.
- **Who may be searched.** That is still decided in the daemon, before the limit. The index is given the allowed threads and returns message matches only. Title and project matches are unchanged.
- **Query length.** Queries of three characters or more use the full-text index. Shorter ones scan the index table, never the thread files.
- **No scan bound.** Threads in `thread.db` are always all searched. `maxMessageThreads` still bounds the scan of threads that are still on JSON.

## Moving a thread from JSON

With the feature on, a JSON thread is imported the first time it is read, in the background:

1. Under the thread's lock, unfinished generations are reconciled and the JSON files are fingerprinted: every data file, the root `manifest.json` and the files of the generation it selects, with whether each exists.
2. The read worker builds `thread.db.import-<pid>-<id>` (and its blobs, in a staging folder beside it) from the files, chosen exactly as the app chooses them, and reads it back to check every row against them.
3. Under the lock again, the fingerprint is checked unchanged, the staged blobs are moved into `blobs/`, and the file is linked into place as `thread.db`, never over an existing one.

A crash at any step leaves either no `thread.db` (an abandoned import file and its staging folder are removed an hour later) or a complete, checked one. An import that fails leaves the thread on JSON, writes the reason to `thread-db-import-error.json` and is tried again later.

The JSON files are left exactly as they were, as a frozen backup, and are never written again.

The lifecycle code that reads agents, subagent sessions and artifact references (inventory, purge, retirement, storage usage) reads them from the database as records named `<folder>/thread.db#agents.json` and so on (`src/mms/data/threadRecords.ts`).

## Going back to an older version

Run `mousse-cli storage export-json` (or `--thread <id>`) first. It writes each thread's data back as the JSON files older versions read, sets the generation pointer aside, and renames `thread.db` to `thread.db.exported-<time>`. The thread is not imported again by itself.

If an older version writes a thread anyway, the next newer run keeps `thread.db` as the record and copies the changed JSON files to `legacy-json/after-downgrade-<time>/`. Nothing is merged without someone choosing it.

## Measuring

`scripts/bench/thread-storage.ts` measures a generated thread of 5,000 messages, 300 tool outputs of 32 to 200 KB and 20 images: time per save, time to open, memory held and size on disk.
