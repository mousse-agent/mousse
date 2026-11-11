import { useEffect, useRef, useState } from "react";

/**
 * Paragraph pacing of a reply that is still streaming: the reply is shown one finished block at a
 * time (a paragraph, a list item, a heading, a line of code), at most every `PACE_MS`, instead of
 * word by word. Each new block then fades in whole (global.css), and the transcript grows in a few
 * larger steps the view can glide after.
 *
 * Code inside a fence is shown a finished line at a time rather than all at once when the fence
 * closes: a long block keeps moving instead of stalling for seconds and then landing as one tall
 * box, and a half-written line never shows.
 */

/** The shortest time between two reveals. */
export const PACE_MS = 400;
/**
 * How long the text may sit still before what is held shows anyway: the model paused (a tool call
 * is coming, or it is thinking), so the block it was writing is as finished as it will be for now.
 */
export const IDLE_FLUSH_MS = 800;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** A list number alone on its line: the text after the blank below it still belongs to it. */
const BARE_LIST_NUMBER = /^\s*\d+[.)]\s*$/;

/**
 * The length of the start of `text` that holds only finished blocks: up to a blank line after
 * text, the start of a list item, heading or fence (the block before it is done), the end of a
 * heading line, or the end of a line of code. Only whole lines are ever counted, so a word being
 * written never shows.
 */
export function finishedBlocksEnd(text: string): number {
  let cut = 0;
  let fence: string | null = null;
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
      if (last && !BARE_LIST_NUMBER.test(last)) cut = next;
    } else {
      const open = FENCE.exec(line);
      if (open) {
        cut = offset;
        fence = open[1]!;
      } else if (HEADING.test(line)) {
        cut = next;
      } else if (LIST_ITEM.test(line)) {
        cut = offset;
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
  return cut;
}

/**
 * The part of a streaming `text` to show. While `paced`, it grows by finished blocks, at most every
 * `PACE_MS`, and all of it shows after `IDLE_FLUSH_MS` without new text. Not paced (the reply
 * ended, or the setting is off), it is the whole text at once. Only the component using it
 * re-renders when a block is revealed.
 */
export function usePacedText(text: string, paced: boolean): string {
  // What is shown lives in the ref; the state only asks for a render when a timer reveals more.
  const [, setRevealed] = useState(0);
  const state = useRef<{ text: string; shown: number; revealedAt: number; timer: number; idle: number } | null>(null);
  state.current ??= {
    text,
    shown: paced ? finishedBlocksEnd(text) : text.length,
    revealedAt: Number.NEGATIVE_INFINITY,
    timer: 0,
    idle: 0,
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
      setRevealed(to);
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
    },
    [s],
  );

  return paced ? text.slice(0, Math.min(s.shown, text.length)) : text;
}
