/**
 * Markdown of a reply that is still streaming, worked on incrementally. The text is cut where the
 * blocks before the cut can no longer change: after a blank line outside a code fence, before a
 * line that starts a new block. Everything before the last such cut is kept from the previous
 * update (its normalised text and its blocks); only the live tail after it is worked on again.
 * Each step gives exactly what working on the whole text would (see tests/renderer/streamingMarkdown.test.ts).
 */

/** A line that continues the block before it even after a blank line: a list item or indented text. */
const CONTINUES = /^(?:[ \t]*(?:[-*+]|\d+[.)])(?:[ \t]|$)| {2,}\S|\t)/;
/** A list number alone on its line, which `normalizeMarkdown` joins with the text after the blank. */
const BARE_LIST_NUMBER = /^\s*\d+[.)]\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/**
 * Syntax that ties blocks together across blank lines: reference definitions, footnotes, raw HTML,
 * display math and directives. Text with any of it is always worked on whole.
 */
const TIED = /^ {0,3}\[[^\]\n]+\]:|\[\^|<[A-Za-z!/]|\$\$|^ {0,3}:::/;
const INLINE_CODE = /`[^`\n]*`/g;

type ScanState = {
  /** The open fence's marker, or null outside a fence. */
  fence: string | null;
  tied: boolean;
};

/**
 * The last offset in `text` after which the blocks before it are final, scanning from `from`
 * (itself such a cut, or 0). 0 when there is none, or when the text has syntax that ties blocks
 * together.
 */
export function stableCut(text: string, from = 0, tied = false): { cut: number; tied: boolean } {
  const state: ScanState = { fence: null, tied };
  let cut = from;
  let lastText = "";
  let sawBlank = false;
  let offset = from;
  while (offset < text.length) {
    const end = text.indexOf("\n", offset);
    // The last line is still being written: a cut never starts at it unless it is complete.
    if (end === -1) break;
    const line = text.slice(offset, end);
    const next = end + 1;
    if (state.fence) {
      const fence = FENCE.exec(line);
      if (fence && fence[1]![0] === state.fence[0] && fence[1]!.length >= state.fence.length && !fence[2]!.trim()) {
        state.fence = null;
      }
      lastText = line;
      sawBlank = false;
      offset = next;
      continue;
    }
    if (!line.trim()) {
      sawBlank = true;
      offset = next;
      continue;
    }
    if (sawBlank && lastText && !CONTINUES.test(line) && !BARE_LIST_NUMBER.test(lastText)) cut = offset;
    sawBlank = false;
    const fence = FENCE.exec(line);
    if (fence) state.fence = fence[1]!;
    else if (TIED.test(line.replace(INLINE_CODE, ""))) state.tied = true;
    lastText = line;
    offset = next;
  }
  // The text after the last complete line can tie blocks too (a definition being written).
  if (!state.tied && offset < text.length && !state.fence && TIED.test(text.slice(offset).replace(INLINE_CODE, ""))) state.tied = true;
  return state.tied ? { cut: 0, tied: true } : { cut, tied: false };
}

/**
 * Works on a growing text in two parts: the part before the last stable cut is done once and kept,
 * the live tail is done again on each call. `whole` is the step on a whole text; `join` puts the
 * results of the parts together.
 */
function incremental<T>(whole: (text: string) => T, join: (head: T, tail: T) => T, empty: T) {
  let prefix = "";
  let head = empty;
  let tied = false;
  return (text: string): T => {
    const continues = prefix !== "" && text.startsWith(prefix);
    if (!continues) {
      prefix = "";
      head = empty;
      tied = false;
    }
    // A reply grows at its end, so only the text after the kept prefix is scanned again.
    const { cut, tied: nowTied } = stableCut(text, prefix.length, tied);
    tied = nowTied;
    if (nowTied || cut === 0) {
      prefix = "";
      head = empty;
      return whole(text);
    }
    if (cut > prefix.length) {
      head = join(head, whole(text.slice(prefix.length, cut)));
      prefix = text.slice(0, cut);
    }
    return join(head, whole(text.slice(cut)));
  };
}

/** `split` (text into blocks) on a growing text, reusing the blocks before the last stable cut. */
export function createIncrementalSplitter(split: (text: string) => string[]): (text: string) => string[] {
  return incremental(split, (head, tail) => (tail.length ? [...head, ...tail] : head), [] as string[]);
}

/** `normalize` (text to text) on a growing text, reusing the normalised text before the last stable cut. */
export function createIncrementalNormalizer(normalize: (text: string) => string): (text: string) => string {
  return incremental(normalize, (head, tail) => head + tail, "");
}
