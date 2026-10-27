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
  let out = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    out += lower.length === char.length ? lower : char;
  }
  return out;
}

/** A query is one line: breaks pasted into the field read as spaces. */
export function cleanQuery(query: string): string {
  return query.replace(/[\r\n]/g, " ");
}

/** Every start of `needle` in `haystack`, without overlap. Both are already normalized. */
export function findOccurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === "") return found;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    found.push(at);
  }
  return found;
}

type PartCache = { math: boolean; parts: SearchablePart[] };
const partCache = new WeakMap<UIMessage, PartCache>();

/**
 * The parts of a message that find reads: the prompt text, and each text part
 * of a reply. Subagent notices, model handoffs and context compaction are drawn
 * as something else and stay out, and so do tool parts.
 */
export function searchableParts(message: UIMessage, math = false): SearchablePart[] {
  const cached = partCache.get(message);
  if (cached && cached.math === math) return cached.parts;
  const parts = readParts(message, math);
  partCache.set(message, { math, parts });
  return parts;
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
  const metadata = message.metadata as { contextHandoff?: unknown; compaction?: unknown } | undefined;
  if (metadata?.contextHandoff || metadata?.compaction) return [];
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
 * cell or code block) and does not overlap itself.
 */
export function buildFindIndex(
  turns: readonly FindTurn[],
  query: string,
  options: { math?: boolean; cap?: number } = {},
): FindMatch[] {
  const needle = normalizeForSearch(cleanQuery(query));
  const cap = options.cap ?? MAX_MATCHES;
  const matches: FindMatch[] = [];
  if (needle === "") return matches;
  let messageOrder = -1;
  for (const turn of turns) {
    const messages = turn.userMsg ? [turn.userMsg, ...turn.assistantMsgs] : turn.assistantMsgs;
    for (const message of messages) {
      messageOrder += 1;
      for (const part of searchableParts(message, options.math)) {
        let ordinal = 0;
        for (let block = 0; block < part.blocks.length; block += 1) {
          const text = normalizeForSearch(part.blocks[block]!);
          for (const offset of findOccurrences(text, needle)) {
            if (matches.length >= cap) return matches;
            matches.push({
              turnKey: turn.key,
              messageId: message.id,
              messageOrder,
              partIndex: part.partIndex,
              ordinal,
              block,
              offset,
              length: needle.length,
            });
            ordinal += 1;
          }
        }
      }
    }
  }
  return matches;
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
export function formatFindCount(index: number | null, total: number, query: string): string {
  if (query === "") return "";
  if (total === 0) return "No matches";
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
