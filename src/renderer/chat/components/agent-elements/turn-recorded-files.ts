import { useCallback, useEffect, useState } from "react";
import type { ReviewFileEntry } from "../../../../shared/review";
import type { TurnFileResult } from "../../../../shared/turnFiles";
import { watchOffscreen } from "../../../lib/offscreenMotion";

/**
 * What the changed-files summary under a turn reads beyond the turn's own Edit and Write calls:
 *
 * - The turn's changes as Mousse recorded them (`review.files` on the turn, the list the Changes tab shows for it). It
 *   sees every file the turn changed inside the thread's folder, whatever changed it: a shell command, a script, a
 *   code generator. It is read once per turn, only for a finished turn whose summary stayed on screen for
 *   `RECORDED_READ_DWELL_MS`, at most `MAX_READS` at a time, and kept for the session, so opening or scrolling a long
 *   thread costs no read per turn.
 * - Which listed files are gone from their path, only while the list is open: one folder listing per folder, and
 *   `review.turnFile` for a file outside the thread's folder.
 */

/** A turn's recorded changes. `root` is the folder the entry paths are relative to. */
export interface RecordedTurn {
  root: string;
  files: ReviewFileEntry[];
}

/** How long a summary stays on screen before its turn is read: scrolling past reads nothing. */
export const RECORDED_READ_DWELL_MS = 300;
const MAX_READS = 2;
const MAX_CACHED = 500;
const MAX_LISTINGS = 4;

/** Per turn: its recorded changes, or null when Mousse recorded none it can show (no checkpoint, no own folder). */
const recorded = new Map<string, RecordedTurn | null>();
const inFlight = new Map<string, Promise<RecordedTurn | null | undefined>>();
const waiting: Array<() => void> = [];
let reading = 0;

function keyOf(threadId: string, turnId: string): string {
  return `${threadId}\n${turnId}`;
}

function remember(key: string, value: RecordedTurn | null): void {
  recorded.delete(key);
  recorded.set(key, value);
  if (recorded.size > MAX_CACHED) recorded.delete(recorded.keys().next().value as string);
}

async function inTurn<T>(run: () => Promise<T>): Promise<T> {
  if (reading >= MAX_READS) await new Promise<void>((resolve) => waiting.push(resolve));
  reading += 1;
  try {
    return await run();
  } finally {
    reading -= 1;
    waiting.shift()?.();
  }
}

/** Undefined when the read failed: it is not kept, so the next showing of the summary asks again. */
function readRecordedTurn(threadId: string, turnId: string): Promise<RecordedTurn | null | undefined> {
  const key = keyOf(threadId, turnId);
  if (recorded.has(key)) return Promise.resolve(recorded.get(key));
  const running = inFlight.get(key);
  if (running) return running;
  const read = inTurn(async () => {
    const result = await window.mousse.review.files({ threadId, scope: { kind: "turn", turnId } });
    const value = result.unavailable ? null : { root: result.root, files: result.files };
    remember(key, value);
    return value;
  })
    .catch(() => undefined)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, read);
  return read;
}

/**
 * The turn's recorded changes once read (undefined until then), and the ref of the element whose time on screen starts
 * the read. Nothing is read without a thread, a turn or `enabled`.
 */
export function useRecordedTurn(
  threadId: string | null,
  turnId: string | undefined,
  enabled: boolean,
): { recorded: RecordedTurn | null | undefined; ref: (element: Element | null) => (() => void) | undefined } {
  const key = enabled && threadId && turnId ? keyOf(threadId, turnId) : null;
  const [read, setRead] = useState<{ key: string; value: RecordedTurn | null } | null>(null);
  const value = key === null ? undefined : read?.key === key ? read.value : recorded.get(key);
  const ref = useCallback((element: Element | null) => {
    if (!element || key === null || !threadId || !turnId || recorded.has(key)) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const stop = watchOffscreen(element, (offscreen) => {
      clearTimeout(timer);
      if (offscreen) return;
      timer = setTimeout(() => {
        void readRecordedTurn(threadId, turnId).then((found) => {
          if (!closed && found !== undefined) setRead({ key, value: found });
        });
      }, RECORDED_READ_DWELL_MS);
    });
    return () => {
      closed = true;
      clearTimeout(timer);
      stop();
    };
  }, [key, threadId, turnId]);
  return { recorded: value, ref };
}

/** A listed file to look for: its path inside the thread's folder, or else the path as the agent wrote it. */
export interface PresenceQuery {
  key: string;
  /** Relative to the thread's folder, with `/`; null for a file outside it. */
  inFolder: string | null;
  /** The path as the agent's Edit or Write call wrote it; null for a file only the recorded list names. */
  written: string | null;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|[\\/])/;
const GONE_ERROR =/ENOENT|ENOTDIR|no such file|cannot find the (file|path)/i;

async function inBatches<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Which of `queries` are gone from their path. A file inside the thread's folder is looked up in one listing of its
 * folder (a folder that is itself gone answers for all its files); a file outside it through `review.turnFile`, which
 * answers only for files the agent's calls wrote. A file that could not be looked up is not called gone.
 */
export async function readGoneFiles(threadId: string, queries: PresenceQuery[], caseInsensitive: boolean): Promise<Set<string>> {
  const gone = new Set<string>();
  const fold = (name: string) => (caseInsensitive ? name.toLowerCase() : name);
  const byFolder = new Map<string, PresenceQuery[]>();
  const outside: PresenceQuery[] = [];
  for (const query of queries) {
    if (query.inFolder !== null) {
      const folder = folderOf(query.inFolder);
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), query]);
    } else if (query.written && ABSOLUTE.test(query.written)) {
      // A relative path outside a known folder names nothing to look for.
      outside.push(query);
    }
  }
  const listings = [...byFolder.entries()].map(([folder, files]) => async () => {
    try {
      const entries = await window.mousse.fs.listDir(folder || undefined, undefined, threadId);
      const present = new Set(entries.map((entry) => fold(entry.name)));
      for (const file of files) if (!present.has(fold(nameOf(file.inFolder!)))) gone.add(file.key);
    } catch (error) {
      if (GONE_ERROR.test(error instanceof Error ? error.message : String(error))) for (const file of files) gone.add(file.key);
    }
  });
  const lookups = outside.map((file) => async () => {
    try {
      const found: TurnFileResult = await window.mousse.review.turnFile({ threadId, path: file.written! });
      if (found.kind === "missing") gone.add(file.key);
    } catch {
      // Not looked up: an older service, a refused path.
    }
  });
  await inBatches([...listings, ...lookups], MAX_LISTINGS, (task) => task());
  return gone;
}

/**
 * The keys of the listed files that are gone, read each time the list opens (`open`) and kept while it stays open
 * with the same files. Empty while closed or still reading.
 */
export function useGoneFiles(threadId: string | null, queries: PresenceQuery[], open: boolean, caseInsensitive: boolean): Set<string> {
  const signature = open && threadId ? queries.map((query) => query.key).join("\n") : "";
  const [gone, setGone] = useState<{ signature: string; keys: Set<string> } | null>(null);
  useEffect(() => {
    if (!signature || !threadId) return undefined;
    let current = true;
    void readGoneFiles(threadId, queries, caseInsensitive).then((keys) => {
      if (current) setGone({ signature, keys });
    });
    return () => {
      current = false;
    };
    // `queries` is read through `signature`: a new array with the same files asks nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, threadId, caseInsensitive]);
  return gone && gone.signature === signature ? gone.keys : EMPTY;
}

const EMPTY: Set<string> = new Set();

/** For tests: forgets every turn read. */
export function resetRecordedTurnsForTests(): void {
  recorded.clear();
  inFlight.clear();
}
