import { COLLAPSE_CLOSE_MS } from "../../../../components/ui/Collapse";

/**
 * Keeps a reader's place while the turn that just finished folds its work away (message-list.tsx). A reader who
 * follows the end needs nothing: the end follower holds the end. A reader up in the thread reads some row; when the
 * work above or around it closes, that row stays where it was on screen. If the row they read is itself work that
 * folds, the nearest row below it that stays visible (the answer, the next prompt) holds instead. The browser's own
 * scroll anchoring cannot do this: it anchors on the row under the reading line, and that row may be the one folding.
 * Neither can the windowed list's holder (use-turn-window.ts): the row it holds is remounted inside the fold, so it
 * falls back to the turn's top, which does not move. It stands down while a hold runs (`foldHoldActive`).
 *
 * `captureFoldHold` runs while the old rows are still on screen (during the render that ends the turn); `runFoldHold`
 * runs once they are replaced, and keeps the row in place until the fold has closed or the reader scrolls.
 */
export type FoldHold = {
  container: HTMLElement;
  scrollTop: number;
  /** Rows at or below the reading line, in order, with where they sat (scroll-content space). */
  marks: Array<{ el: Element; pos: number }>;
};

/** What closes: a turn's folded work (a `Collapse` straight inside the turn's column). */
const FOLDING = ".turn-answer > .ui-collapse";
/** On the scroller while a hold runs: native scroll anchoring is off (global.css). */
const HOLD_ATTR = "data-fold-hold";

/**
 * Whether a fold hold owns the scroll position now. The windowed list's own reading-line holder (use-turn-window.ts)
 * stands down while it does, so one writer corrects the view at a time.
 */
export function foldHoldActive(container: HTMLElement): boolean {
  return container.hasAttribute(HOLD_ATTR);
}

function contentTop(container: HTMLElement): number {
  return container.getBoundingClientRect().top + container.clientTop;
}

/**
 * The finishing turn's rows (its prompt, its line, each row of its column) and every other turn as one row, from the
 * reading line down: the row that holds may be below the view when everything in view folds.
 */
export function captureFoldHold(container: HTMLElement | null, rows: HTMLElement | null): FoldHold | null {
  if (!container || !rows) return null;
  const turns = [...rows.querySelectorAll<HTMLElement>(":scope > [data-turn-key]")];
  const last = turns.at(-1);
  if (!last) return null;
  const candidates: Element[] = [
    ...turns.slice(0, -1),
    ...last.querySelectorAll(
      ":scope > :not(.group\\/assistant-turn), :scope > .group\\/assistant-turn > :not(.turn-answer), :scope > .group\\/assistant-turn > .turn-answer > *",
    ),
  ];
  const top = contentTop(container);
  const marks: FoldHold["marks"] = [];
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= top) continue;
    marks.push({ el, pos: rect.top - top + container.scrollTop });
  }
  if (!marks.length) return null;
  // The browser's anchor would move the view a second time (and may pick a row that folds): off while this holds.
  container.setAttribute(HOLD_ATTR, "");
  return { container, scrollTop: container.scrollTop, marks };
}

/**
 * Holds the first captured row that is still there and stays visible, frame by frame, until the fold has closed.
 * Stops early when the reader scrolls or starts following the end. Returns a function that stops it.
 */
export function runFoldHold(hold: FoldHold, options: { following: () => boolean; onWrite: () => void }): () => void {
  const { container } = hold;
  const mark = hold.marks.find(({ el }) => el.isConnected && !el.closest(FOLDING) && el.getBoundingClientRect().height > 0);
  if (!mark) {
    container.removeAttribute(HOLD_ATTR);
    return () => {};
  }
  let wrote = container.scrollTop;
  let frame = 0;
  // Two frames before the close starts (TurnRow), the close itself, and a margin for a slow frame.
  const until = performance.now() + COLLAPSE_CLOSE_MS + 200;
  const apply = (): boolean => {
    if (!mark.el.isConnected || options.following()) return false;
    // The reader scrolled since the last write: their position wins.
    if (Math.abs(container.scrollTop - wrote) > 1) return false;
    const pos = mark.el.getBoundingClientRect().top - contentTop(container) + container.scrollTop;
    const target = hold.scrollTop + (pos - mark.pos);
    if (Math.abs(container.scrollTop - target) >= 1) {
      options.onWrite();
      container.scrollTop = target;
    }
    wrote = container.scrollTop;
    return true;
  };
  const release = () => container.removeAttribute(HOLD_ATTR);
  const step = () => {
    frame = 0;
    if (!apply() || performance.now() > until) return release();
    frame = requestAnimationFrame(step);
  };
  // The rows were just replaced: the native anchor may have moved the view already, so the first write is absolute.
  wrote = container.scrollTop;
  if (apply()) frame = requestAnimationFrame(step);
  else release();
  return () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    release();
  };
}
