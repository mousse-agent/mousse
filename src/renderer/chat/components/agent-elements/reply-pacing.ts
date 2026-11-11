import { useEffect, useRef, useState } from "react";

/**
 * Paragraph pacing of a reply that is still streaming: the reply is shown one finished block at a
 * time (a paragraph, a list item, a heading, a line of code, a table row, a quoted line), at most
 * every `PACE_MS`, instead of word by word. Each new block then fades in whole (global.css), and the
 * transcript grows in a few larger steps the view can glide after.
 *
 * Code inside a fence is shown a finished line at a time rather than all at once when the fence
 * closes: a long block keeps moving instead of stalling for seconds and then landing as one tall
 * box, and a half-written line never shows. Tables and quotes go a finished row or line at a time
 * the same way.
 */

/** The shortest time between two reveals. */
export const PACE_MS = 400;
/**
 * How long the text may sit still before what is held shows anyway: the model paused (a tool call
 * is coming, or it is thinking), so the block it was writing is as finished as it will be for now.
 */
export const IDLE_FLUSH_MS = 800;
/**
 * The longest a reader waits for something new while text keeps arriving: a long paragraph shows up
 * to its last finished sentence or line instead of not at all.
 */
export const MAX_HOLD_MS = 1500;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const QUOTE = /^ {0,3}>/;
const TABLE_ROW = /\|/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
/** A list number alone on its line: the text after the blank below it still belongs to it. */
const BARE_LIST_NUMBER = /^\s*\d+[.)]\s*$/;
/** The end of a sentence: its stop and any closing quote or emphasis, before white space. */
const SENTENCE_END = /[.!?…]["'”’)\]*_]*(?=\s)/g;

/** Where the finished blocks of `text` end, and whether the text ends inside a code fence. */
function scanBlocks(text: string): { cut: number; inFence: boolean } {
  let cut = 0;
  let fence: string | null = null;
  let table = false;
  let last = "";
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf("\n", offset);
    if (end === -1) break;
    const line = text.slice(offset, end);
    const next = end + 1;
    if (fence !== null) {
      const close = FENCE.exec(line);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length && !close[2]!.trim()) fence = null;
      // A finished line of code, or the line that closes the fence.
      cut = next;
      last = line;
    } else if (!line.trim()) {
      table = false;
      if (last && !BARE_LIST_NUMBER.test(last)) cut = next;
    } else {
      const open = FENCE.exec(line);
      if (open) {
        cut = offset;
        fence = open[1]!;
        table = false;
      } else if (table && TABLE_ROW.test(line)) {
        // A finished row of a table already on screen.
        cut = next;
      } else if (TABLE_DELIMITER.test(line) && TABLE_ROW.test(last) && line.includes("-")) {
        // The header row and its delimiter: the table can show, header first.
        table = true;
        cut = next;
      } else if (HEADING.test(line) || QUOTE.test(line)) {
        table = false;
        cut = next;
      } else if (LIST_ITEM.test(line)) {
        table = false;
        cut = offset;
      } else {
        table = false;
      }
      last = line;
    }
    offset = next;
  }
  // A line being written that starts a new block already ends the one before it.
  if (fence === null && offset < text.length) {
    const rest = text.slice(offset);
    if (FENCE.test(rest) || HEADING.test(rest) || LIST_ITEM.test(rest)) cut = offset;
  }
  return { cut, inFence: fence !== null };
}

/**
 * The length of the start of `text` that holds only finished blocks: up to a blank line after
 * text, the start of a list item, heading or fence (the block before it is done), the end of a
 * heading line, or the end of a line of code, a table row or a quoted line. Only whole lines are
 * ever counted, so a word being written never shows.
 */
export function finishedBlocksEnd(text: string): number {
  return scanBlocks(text).cut;
}

/**
 * Where a reply that has held text too long may be shown up to: its finished blocks, or else the
 * last finished line or sentence after them. Inside a code fence only whole lines count.
 */
export function readableEnd(text: string): number {
  const { cut, inFence } = scanBlocks(text);
  let end = cut;
  const lineEnd = text.lastIndexOf("\n");
  if (lineEnd + 1 > end) end = lineEnd + 1;
  if (!inFence) {
    SENTENCE_END.lastIndex = end;
    for (let match = SENTENCE_END.exec(text); match; match = SENTENCE_END.exec(text)) {
      end = Math.max(end, match.index + match[0].length);
    }
  }
  return end;
}

/**
 * The part of a streaming `text` to show. While `paced`, it grows by finished blocks, at most every
 * `PACE_MS`; all of it shows after `IDLE_FLUSH_MS` without new text, and up to the last finished
 * sentence after `MAX_HOLD_MS` of text arriving with nothing new shown. Not paced (the reply ended,
 * the setting is off, find is open), it is the whole text at once. Only the component using it
 * re-renders when a block is revealed.
 */
export function usePacedText(text: string, paced: boolean): string {
  // What is shown lives in the ref; the state only asks for a render when a timer reveals more.
  const [, setRevealed] = useState(0);
  const state = useRef<{
    text: string;
    shown: number;
    revealedAt: number;
    timer: number;
    idle: number;
    hold: number;
  } | null>(null);
  state.current ??= {
    text,
    shown: paced ? finishedBlocksEnd(text) : text.length,
    revealedAt: Number.NEGATIVE_INFINITY,
    timer: 0,
    idle: 0,
    hold: 0,
  };
  const s = state.current;
  s.text = text;
  // Not paced, everything shows; turning pacing back on goes on from there, it never hides text.
  if (!paced) s.shown = text.length;

  useEffect(() => {
    if (!paced) return;
    const reveal = (to: number) => {
      if (to <= s.shown) return;
      s.revealedAt = performance.now();
      s.shown = to;
      window.clearTimeout(s.hold);
      s.hold = 0;
      setRevealed(to);
    };
    const holdTooLong = () => {
      s.hold = 0;
      reveal(readableEnd(s.text));
      // Nothing readable yet (one long sentence): look again after another while.
      if (s.text.length > s.shown) s.hold = window.setTimeout(holdTooLong, MAX_HOLD_MS);
    };
    const target = finishedBlocksEnd(text);
    if (target > s.shown) {
      const wait = s.revealedAt + PACE_MS - performance.now();
      if (wait <= 0) reveal(target);
      else if (!s.timer) {
        s.timer = window.setTimeout(() => {
          s.timer = 0;
          reveal(finishedBlocksEnd(s.text));
        }, wait);
      }
    }
    // Text is waiting with nothing new shown: it gets at most MAX_HOLD_MS (a reveal restarts it).
    if (text.length > s.shown && !s.hold) s.hold = window.setTimeout(holdTooLong, MAX_HOLD_MS);
    window.clearTimeout(s.idle);
    s.idle = 0;
    if (text.length > s.shown) {
      s.idle = window.setTimeout(() => {
        s.idle = 0;
        reveal(s.text.length);
      }, IDLE_FLUSH_MS);
    }
  }, [text, paced, s]);

  useEffect(
    () => () => {
      window.clearTimeout(s.timer);
      window.clearTimeout(s.idle);
      window.clearTimeout(s.hold);
    },
    [s],
  );

  return paced ? text.slice(0, Math.min(s.shown, text.length)) : text;
}
