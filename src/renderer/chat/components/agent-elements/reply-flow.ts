import { useEffect, useRef, useState } from "react";
import { useMotionScale } from "../../../lib/motion";

/**
 * Word flow of a reply that is still streaming, for a bot's chat: the reply is shown a few whole
 * words at a time, at an even pace, so it reads as a steady flow instead of jumps of a sentence or a
 * paragraph. Each word that shows fades in (`revealWords` on Markdown, global.css). A thread keeps
 * its calmer paragraph pacing (`usePacedText`).
 *
 * Nothing that shows ever has to change shape later, so lines already on screen do not re-wrap:
 * - only whole words show, never one still being written;
 * - a line that is so far only the start of a block (a list bullet or number, a heading's `#`, a
 *   quote's `>`, a fence, a table row, the `-` or `=` that would turn the line above into a
 *   heading) waits for its words, or for its end;
 * - inside a code fence only finished lines show, as a thread shows code.
 */

/** Time between two steps of the flow. */
export const FLOW_TICK_MS = 50;
/** A step shows enough words that what has arrived and is not shown yet shows within about this. */
export const FLOW_CATCH_UP_MS = 500;
/** With no new text for this long, a last word that ends a sentence or clause shows too (`quietEnd`). */
export const FLOW_IDLE_MS = 800;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A line that is only a block's start so far: what it becomes depends on words not here yet. */
const BLOCK_START_ONLY = /^ {0,3}(?:[-*+]|\d{1,9}[.)]|#{1,6}|>+|[-=_*]+)?[ \t]*$/;
/** A table row: shown once its line ends, so it never shows as a paragraph first. */
const TABLE_ROW = /^ {0,3}\|/;

/** Where `text` may show up to when it ends inside an open code fence (its last finished line), or null when it does not. */
function openFence(text: string): number | null {
  let fence: string | null = null;
  let fenceStart = 0;
  let lineEnd = 0;
  let offset = 0;
  while (offset <= text.length) {
    const end = text.indexOf("\n", offset);
    if (end === -1) break;
    const line = text.slice(offset, end);
    if (fence !== null) {
      const close = FENCE.exec(line);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length && !close[2]!.trim()) fence = null;
    } else {
      const open = FENCE.exec(line);
      if (open) {
        fence = open[1]!;
        fenceStart = offset;
      }
    }
    lineEnd = end + 1;
    offset = end + 1;
  }
  // The line being written opens a fence: nothing of it shows yet.
  if (fence === null && FENCE.test(text.slice(offset))) return offset;
  if (fence === null) return null;
  // A fence with no finished line yet shows nothing: its box appears with its first line.
  return text.indexOf("\n", fenceStart) + 1 === lineEnd ? fenceStart : lineEnd;
}

/**
 * The length of the start of a streaming `text` that may show: up to the last whole word, never a
 * word being written, a line that is only a block's start, an unfinished table row, or an
 * unfinished line of code.
 */
export function flowEnd(text: string): number {
  const fenced = openFence(text);
  if (fenced !== null) return fenced;
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart);
  if (TABLE_ROW.test(line)) return lineStart;
  // Whole words only: up to the last white space.
  let end = text.length;
  while (end > lineStart && !/\s/.test(text[end - 1]!)) end--;
  if (BLOCK_START_ONLY.test(text.slice(lineStart, end))) return lineStart;
  return end;
}

/** Ends that make a last word whole with no white space after it: a reply's last word usually has one. */
const WORD_END = /[\p{L}\p{N}][.!?…:;,)\]"'”’*_`]+$/u;

/**
 * Where a reply with no new text for `FLOW_IDLE_MS` may show up to: as `flowEnd`, and its last word too when that ends
 * a sentence or clause (`$140?`, `done.`). A word cut off without one still waits: it would change when the rest comes,
 * and the posted message brings it anyway.
 */
export function quietEnd(text: string): number {
  return WORD_END.test(text) ? Math.min(text.length, flowEnd(`${text} `)) : flowEnd(text);
}

/**
 * Characters a step shows: enough that what is waiting shows within `FLOW_CATCH_UP_MS`, and never fewer than the step
 * before while the flow is behind, so a burst drains at an even pace instead of slowing to a crawl at its end.
 */
export function flowStepSize(waiting: number, previous: number): number {
  return Math.max(previous, Math.ceil((waiting * FLOW_TICK_MS) / FLOW_CATCH_UP_MS));
}

/** Where the next step of the flow ends: `size` characters on, then on to the end of that word: at least one whole word. */
export function nextFlowStep(text: string, shown: number, target: number, size: number): number {
  if (shown >= target) return target;
  const want = shown + Math.max(1, size);
  if (want >= target) return target;
  // On to the end of the word `want` falls in, and the white space after it; past a place that could not show on its
  // own (just after a list bullet, inside a line of code) to the next one that can.
  let end = want;
  do {
    while (end < target && !/\s/.test(text[end]!)) end++;
    while (end < target && /\s/.test(text[end]!)) end++;
  } while (end < target && flowEnd(text.slice(0, end)) < end);
  return end;
}

/**
 * The part of a streaming `text` to show. While `flowing`, it moves toward `flowEnd(text)` a few
 * words every `FLOW_TICK_MS`, catching up within about `FLOW_CATCH_UP_MS`; with no new text for
 * `FLOW_IDLE_MS`, a last word that ends a sentence shows too (`quietEnd`). With Animation speed Off
 * or reduced motion the words show as they come, with no flow. Not flowing, it is the whole text.
 * A new `key` (another reply in the same place) starts the flow again from nothing, without remounting the caller.
 */
export function useFlowingText(text: string, flowing: boolean, key = ''): string {
  const still = useMotionScale() === 0;
  const [, setStep] = useState(0);
  const state = useRef<{ key: string; shown: number; text: string; tick: number; idle: number; size: number; quiet: boolean } | null>(null);
  state.current ??= { key, shown: 0, text, tick: 0, idle: 0, size: 0, quiet: false };
  const s = state.current;
  if (s.key !== key) {
    window.clearTimeout(s.tick);
    window.clearTimeout(s.idle);
    Object.assign(s, { key, shown: 0, tick: 0, idle: 0, size: 0, quiet: false });
  }
  // New text: the reply is being written again.
  if (s.text !== text) s.quiet = false;
  s.text = text;
  const target = () => (s.quiet ? quietEnd(s.text) : flowEnd(s.text));
  // Text can shrink (a silent marker dropped): what shows never runs past it.
  if (s.shown > text.length) s.shown = text.length;
  if (!flowing) s.shown = text.length;
  else if (still) s.shown = Math.max(s.shown, target());

  useEffect(() => {
    if (!flowing) return;
    const step = () => {
      s.tick = 0;
      const end = target();
      s.size = flowStepSize(end - s.shown, s.size);
      const next = nextFlowStep(s.text, s.shown, end, s.size);
      if (next > s.shown) {
        s.shown = next;
        setStep((n) => n + 1);
      }
      if (s.shown < end) s.tick = window.setTimeout(step, FLOW_TICK_MS);
      else s.size = 0;
    };
    const flow = () => {
      if (still) {
        const end = target();
        if (end > s.shown) {
          s.shown = end;
          setStep((n) => n + 1);
        }
      } else if (!s.tick && target() > s.shown) s.tick = window.setTimeout(step, s.shown === 0 ? 0 : FLOW_TICK_MS);
    };
    flow();
    window.clearTimeout(s.idle);
    s.idle = 0;
    if (text.length > s.shown) {
      s.idle = window.setTimeout(() => {
        s.idle = 0;
        s.quiet = true;
        flow();
      }, FLOW_IDLE_MS);
    }
    // `target` reads the state, which lives as long as the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, flowing, still, s, key]);

  useEffect(
    () => () => {
      window.clearTimeout(s.tick);
      window.clearTimeout(s.idle);
      // StrictMode (dev) runs this once on mount; the effect above re-arms only timers whose id is 0.
      s.tick = 0;
      s.idle = 0;
    },
    [s],
  );

  return flowing ? text.slice(0, s.shown) : text;
}
