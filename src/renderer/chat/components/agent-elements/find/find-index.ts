import type { UIMessage } from "ai";
import { readSubagentNotice } from "../../../adapters/subagentNotice";
import { isTextPart } from "../utils/assistant-blocks";
import { markdownToSearchBlocks, plainTextToSearchBlocks } from "./search-text";

/** A turn as the list groups it, with the key its row is mounted under. */
export type FindTurn = {
  key: string;
  userMsg?: UIMessage;
  assistantMsgs: UIMessage[];
};

/** One searchable piece of a message: a prompt, or one text part of a reply. */
export type SearchablePart = { partIndex: number; blocks: string[] };

export type FindMatch = {
  turnKey: string;
  messageId: string;
  /** Position of the message among all the thread's messages that find reads. */
  messageOrder: number;
  partIndex: number;
  /** Position among the occurrences inside this part, in reading order. */
  ordinal: number;
  block: number;
  /** Offsets inside the normalized block text. */
  offset: number;
  length: number;
};

/** What stays the same for a match while the index is rebuilt around it. */
export type MatchIdentity = {
  messageId: string;
  messageOrder: number;
  partIndex: number;
  ordinal: number;
};

export const MAX_MATCHES = 5000;

/**
 * Lowercases for comparison without ever changing the text's length: a code
 * point whose lowercase form has a different number of UTF-16 units (`İ`) is
 * kept as it is. There is no Unicode normalization either, since that would
 * move offsets (`é needle` becomes shorter under NFC). So an offset in the
 * normalized text is an offset in the text it came from, and the same function
 * serves the index, the query and the text collected from the page.
 *
 * Limitation: a precomposed `é` in the query does not match a decomposed one
 * in the text, or the other way round.
 */
export function normalizeForSearch(text: string): string {
  // Fast path: lowercasing never shortens a code point, so the same length means
  // every code point kept its length and the offsets line up.
  const whole = text.toLowerCase();
  if (whole.length === text.length) return whole;
  let out = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    out += lower.length === char.length ? lower : char;
  }
  return out;
}

/**
 * A query is one line: breaks pasted into the field read as spaces. The
 * separator the index joins blocks with is taken out, so no match spans two.
 */
export function cleanQuery(query: string): string {
  return query.replace(/[\r\n]/g, " ").replaceAll(BLOCK_SEPARATOR, "");
}

/** Joins the blocks of a part in the index's lowercased text. */
const BLOCK_SEPARATOR = "\u0000";

/** Every start of `needle` in `haystack`, without overlap. Both are already normalized. */
export function findOccurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === "") return found;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    found.push(at);
  }
  return found;
}

/** A searchable part with its text lowercased once: the blocks joined by BLOCK_SEPARATOR. */
type IndexedPart = SearchablePart & { lower: string; starts: number[] };

type Entry = {
  /** The message's revision: what its parts are read from. It is read again only when this changes. */
  source: readonly unknown[];
  parts: IndexedPart[];
};

type HiddenMetadata = { contextHandoff?: unknown; compaction?: unknown; contextCleared?: unknown } | undefined;

/** What a message's searchable parts depend on: its role, the flags that hide it, and its text parts. */
function sourceOf(message: UIMessage): unknown[] {
  const metadata = message.metadata as HiddenMetadata;
  const source: unknown[] = [
    message.role,
    Boolean(metadata?.contextHandoff || metadata?.compaction || metadata?.contextCleared),
    message.role === "user" && readSubagentNotice(message) !== null,
  ];
  for (const part of message.parts ?? []) source.push(isTextPart(part) ? part.text : null);
  return source;
}

function sameSource(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function indexPart(part: SearchablePart): IndexedPart {
  const starts: number[] = [];
  let at = 0;
  for (const block of part.blocks) {
    starts.push(at);
    at += block.length + BLOCK_SEPARATOR.length;
  }
  return { ...part, lower: normalizeForSearch(part.blocks.join(BLOCK_SEPARATOR)), starts };
}

/**
 * A thread's find index: each message's searchable text, lowercased once and
 * cached by message id and revision (its text parts and the flags that hide
 * it). A message whose text changes (a reply streaming in) is read again on its
 * own; the rest are reused, so a keystroke costs one `indexOf` pass over the
 * cached text. Reading a long reply's Markdown is the expensive step, so
 * `indexSome` does it in slices of a time budget, and a search can cover only
 * the messages read so far.
 */
export class FindIndex {
  private readonly byId = new Map<string, Entry>();
  private readonly byMessage = new WeakMap<UIMessage, Entry>();

  constructor(readonly math = false) {}

  /** The message's entry when it is current, else null. */
  private current(message: UIMessage): Entry | null {
    const known = this.byMessage.get(message);
    if (known) return known;
    const entry = this.byId.get(message.id);
    if (!entry || !sameSource(entry.source, sourceOf(message))) return null;
    this.byMessage.set(message, entry);
    return entry;
  }

  private reads = 0;

  /** How many messages have been read; it changes whenever the index does. */
  get revision(): number {
    return this.reads;
  }

  private read(message: UIMessage): Entry {
    this.reads += 1;
    const entry: Entry = { source: sourceOf(message), parts: readParts(message, this.math).map(indexPart) };
    this.byId.set(message.id, entry);
    this.byMessage.set(message, entry);
    return entry;
  }

  /** The parts of a message, read now if they are not current. */
  partsOf(message: UIMessage): IndexedPart[] {
    return (this.current(message) ?? this.read(message)).parts;
  }

  isIndexed(message: UIMessage): boolean {
    return this.current(message) !== null;
  }

  /**
   * Reads the messages that are not current, in the order given, until
   * `budgetMs` has run out (at least one is read). Returns whether every one is
   * current.
   */
  indexSome(messages: Iterable<UIMessage>, budgetMs: number, now: () => number = () => performance.now()): boolean {
    const deadline = now() + budgetMs;
    let read = 0;
    for (const message of messages) {
      if (this.current(message)) continue;
      if (read > 0 && now() >= deadline) return false;
      this.read(message);
      read += 1;
    }
    return true;
  }

  /** How many of the thread's messages are not current, counting up to `limit`. */
  missing(turns: readonly FindTurn[], limit: number): number {
    let count = 0;
    for (const turn of turns) {
      if (turn.userMsg && !this.current(turn.userMsg) && ++count >= limit) return count;
      for (const message of turn.assistantMsgs) if (!this.current(message) && ++count >= limit) return count;
    }
    return count;
  }

  /** Forgets the messages that are no longer in the thread. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.byId.keys()) if (!ids.has(id)) this.byId.delete(id);
  }

  /**
   * Every occurrence of `query`, in reading order, up to `cap`. With
   * `readMissing: false` a message that is not read yet is skipped and
   * `complete` comes back false; by default it is read on the spot.
   */
  search(
    turns: readonly FindTurn[],
    query: string,
    options: { cap?: number; readMissing?: boolean } = {},
  ): { matches: FindMatch[]; complete: boolean } {
    const needle = normalizeForSearch(cleanQuery(query));
    const cap = options.cap ?? MAX_MATCHES;
    const readMissing = options.readMissing ?? true;
    const matches: FindMatch[] = [];
    let complete = true;
    if (needle === "") return { matches, complete };
    let messageOrder = -1;
    for (const turn of turns) {
      const messages = turn.userMsg ? [turn.userMsg, ...turn.assistantMsgs] : turn.assistantMsgs;
      for (const message of messages) {
        messageOrder += 1;
        const entry = this.current(message) ?? (readMissing ? this.read(message) : null);
        if (!entry) {
          complete = false;
          continue;
        }
        for (const part of entry.parts) {
          const { lower, starts } = part;
          let ordinal = 0;
          let block = 0;
          for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
            if (matches.length >= cap) return { matches, complete };
            while (block + 1 < starts.length && starts[block + 1]! <= at) block += 1;
            matches.push({
              turnKey: turn.key,
              messageId: message.id,
              messageOrder,
              partIndex: part.partIndex,
              ordinal,
              block,
              offset: at - starts[block]!,
              length: needle.length,
            });
            ordinal += 1;
          }
        }
      }
    }
    return { matches, complete };
  }
}

/** For the one-off calls below; the find bar keeps an index per transcript. */
const sharedIndexes = { plain: new FindIndex(false), math: new FindIndex(true) };

/**
 * The parts of a message that find reads: the prompt text, and each text part
 * of a reply. Subagent notices, model handoffs and context compaction are drawn
 * as something else and stay out, and so do tool parts.
 */
export function searchableParts(message: UIMessage, math = false): SearchablePart[] {
  return (math ? sharedIndexes.math : sharedIndexes.plain)
    .partsOf(message)
    .map(({ partIndex, blocks }) => ({ partIndex, blocks }));
}

function readParts(message: UIMessage, math: boolean): SearchablePart[] {
  const parts = message.parts ?? [];
  if (message.role === "user") {
    if (readSubagentNotice(message)) return [];
    const text = parts
      .filter(isTextPart)
      .map((part) => part.text)
      .join("");
    const blocks = plainTextToSearchBlocks(text);
    return blocks.length > 0 ? [{ partIndex: 0, blocks }] : [];
  }
  if (message.role !== "assistant") return [];
  const metadata = message.metadata as HiddenMetadata;
  if (metadata?.contextHandoff || metadata?.compaction || metadata?.contextCleared) return [];
  const result: SearchablePart[] = [];
  parts.forEach((part, partIndex) => {
    if (!isTextPart(part) || !part.text) return;
    const blocks = markdownToSearchBlocks(part.text, { math });
    if (blocks.length > 0) result.push({ partIndex, blocks });
  });
  return result;
}

/**
 * Every occurrence of `query` in the thread, in reading order. The search is
 * case-insensitive, runs inside one block at a time (never across a paragraph,
 * cell or code block) and does not overlap itself. It reads every message it
 * needs at once; the find bar reads them in slices through its own `FindIndex`.
 */
export function buildFindIndex(
  turns: readonly FindTurn[],
  query: string,
  options: { math?: boolean; cap?: number } = {},
): FindMatch[] {
  return (options.math ? sharedIndexes.math : sharedIndexes.plain).search(turns, query, { cap: options.cap }).matches;
}

export function identityOf(match: FindMatch): MatchIdentity {
  return {
    messageId: match.messageId,
    messageOrder: match.messageOrder,
    partIndex: match.partIndex,
    ordinal: match.ordinal,
  };
}

function sameIdentity(match: FindMatch, identity: MatchIdentity): boolean {
  return (
    match.messageId === identity.messageId &&
    match.partIndex === identity.partIndex &&
    match.ordinal === identity.ordinal
  );
}

/** The next or previous match, wrapping at both ends. `null` when there is none. */
export function stepMatch(count: number, active: number | null, delta: 1 | -1): number | null {
  if (count <= 0) return null;
  if (active === null || active < 0 || active >= count) return delta > 0 ? 0 : count - 1;
  return (((active + delta) % count) + count) % count;
}

/** "3 of 12", "No matches", or nothing while the field is empty. `index` is zero-based. */
export function formatFindCount(index: number | null, total: number, query: string, pending = false): string {
  if (query === "") return "";
  if (total === 0) return pending ? "Searching…" : "No matches";
  // Still reading the thread: more may come.
  if (pending) return index === null ? `${total}…` : `${index + 1} of ${total}…`;
  if (index === null) return total === 1 ? "1 match" : `${total} matches`;
  return `${index + 1} of ${total}${total >= MAX_MATCHES ? "+" : ""}`;
}

/**
 * Where a new search starts: the first match in the turn at the top of the
 * view or below it, skipping the ones that sit above the top edge inside that
 * turn. Past the last one it wraps to the first.
 */
export function initialMatch(
  matches: readonly FindMatch[],
  turnOrder: readonly string[],
  viewport: { anchorTurnKey: string | null; isAboveViewport?: (match: FindMatch) => boolean },
): number | null {
  if (matches.length === 0) return null;
  const turnIndex = new Map(turnOrder.map((key, index) => [key, index]));
  const anchor = viewport.anchorTurnKey === null ? 0 : (turnIndex.get(viewport.anchorTurnKey) ?? 0);
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const at = turnIndex.get(match.turnKey) ?? 0;
    if (at > anchor) return index;
    if (at === anchor && !viewport.isAboveViewport?.(match)) return index;
  }
  return 0;
}

/**
 * The index of the previously active match after the index was rebuilt: the
 * same occurrence when it still exists, else the next one after its place.
 * Matches arriving earlier or later in the thread do not move the selection.
 */
export function reselect(matches: readonly FindMatch[], previous: MatchIdentity | null): number | null {
  if (previous === null || matches.length === 0) return null;
  const same = matches.findIndex((match) => sameIdentity(match, previous));
  if (same !== -1) return same;
  const after = matches.findIndex(
    (match) =>
      match.messageOrder > previous.messageOrder ||
      (match.messageOrder === previous.messageOrder &&
        (match.partIndex > previous.partIndex ||
          (match.partIndex === previous.partIndex && match.ordinal > previous.ordinal))),
  );
  return after === -1 ? matches.length - 1 : after;
}
