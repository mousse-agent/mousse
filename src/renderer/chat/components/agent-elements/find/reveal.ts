import { SETTLE_MAX_FRAMES, SETTLE_STABLE_FRAMES } from "../virtual/turn-window";
import type { FindPainter } from "./dom-highlight";

/** Space kept between the match and the edge of whatever scrolls it. */
export const REVEAL_MARGIN = 16;

export type RevealTarget = {
  turnKey: string;
  messageId: string;
  partIndex: number;
  ordinal: number;
};

/** The part of a navigation token the reveal needs: whether it is still the current one, and when it ends. */
export type RevealNavigation = { isCurrent: () => boolean; end: () => void };

export type RevealDeps = {
  /** The transcript's scroll container. */
  container: HTMLElement;
  painter: Pick<FindPainter, "locate" | "locateFirstInPart" | "row" | "setActive">;
  /** Brings a turn that is not mounted into the window; resolves once the landing settled or was cancelled. */
  scrollToKey: (
    key: string,
    target: { align: "start" },
    navigation: RevealNavigation,
  ) => Promise<boolean>;
  /** Called before every write to the container's `scrollTop`. */
  onProgrammaticScroll: () => void;
  /** Resolves on the next frame. */
  nextFrame?: () => Promise<void>;
};

export type RevealResult = "revealed" | "cancelled" | "missing";

const defaultFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function isScroller(element: Element): boolean {
  const style = getComputedStyle(element);
  const scrollsY = style.overflowY === "auto" || style.overflowY === "scroll";
  const scrollsX = style.overflowX === "auto" || style.overflowX === "scroll";
  return (
    (scrollsY && element.scrollHeight > element.clientHeight) ||
    (scrollsX && element.scrollWidth > element.clientWidth)
  );
}

/** A mounted row within a viewport's height of the visible area; a missing row is not near anything. */
function isNearViewport(row: Element | null, container: HTMLElement): boolean {
  if (!row) return false;
  const rect = row.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  return rect.bottom >= box.top - box.height && rect.top <= box.bottom + box.height;
}

/** How far `inner` lies outside `outer` along one axis, keeping `margin` clear; 0 when it fits. */
function overshoot(innerStart: number, innerEnd: number, outerStart: number, outerEnd: number): number {
  if (innerEnd - innerStart > outerEnd - outerStart - 2 * REVEAL_MARGIN) return innerStart - (outerStart + REVEAL_MARGIN);
  if (innerStart < outerStart + REVEAL_MARGIN) return innerStart - (outerStart + REVEAL_MARGIN);
  if (innerEnd > outerEnd - REVEAL_MARGIN) return innerEnd - (outerEnd - REVEAL_MARGIN);
  return 0;
}

/**
 * Puts the range where the reader can see it. First every scroller between the
 * range and the transcript, innermost first (a code block's own scroller, a
 * table's, an expanded thought's), since only then is the range's rectangle the
 * place the reader sees it; then the transcript.
 */
export function bringIntoView(range: Range, deps: Pick<RevealDeps, "container" | "onProgrammaticScroll">): void {
  const { container } = deps;
  const start = range.commonAncestorContainer;
  let element: Element | null = start instanceof Element ? start : start.parentElement;
  for (; element && element !== container; element = element.parentElement) {
    if (!isScroller(element)) continue;
    const rect = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const dy = overshoot(rect.top, rect.bottom, box.top, box.bottom);
    const dx = overshoot(rect.left, rect.right, box.left, box.right);
    if (dy !== 0) element.scrollTop += dy;
    if (dx !== 0) element.scrollLeft += dx;
  }
  const rect = range.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  const fits =
    rect.top >= box.top + REVEAL_MARGIN &&
    rect.bottom <= box.bottom - REVEAL_MARGIN &&
    rect.height <= box.height - 2 * REVEAL_MARGIN;
  if (fits) return;
  const centered = rect.top + rect.height / 2 - (box.top + box.height / 2);
  const delta = rect.height > box.height - 2 * REVEAL_MARGIN ? rect.top - (box.top + REVEAL_MARGIN) : centered;
  if (Math.abs(delta) < 1) return;
  deps.onProgrammaticScroll();
  container.scrollTop += delta;
}

/**
 * Takes the reader to one occurrence. The whole operation runs under the
 * navigation token it is given, so a wheel turn, a new query, closing the bar or
 * unmounting ends it: every wait checks the token and a stale step never writes.
 *
 * 1. A turn that is not mounted, or is mounted far from the viewport (the first
 *    and last turns always are), is landed on through the turn window, then the
 *    row is waited for.
 * 2. The occurrence is found among the mounted row's text (the first one of the
 *    part when the exact one is gone; the row itself when the part is).
 * 3. It is brought into view (see `bringIntoView`).
 * 4. On the frames that follow, while the range still moves (late syntax
 *    highlighting, rows measured, placeholders expanding), it is brought into
 *    view again.
 */
export async function revealMatch(
  target: RevealTarget,
  navigation: RevealNavigation,
  deps: RevealDeps,
): Promise<RevealResult> {
  const nextFrame = deps.nextFrame ?? defaultFrame;
  const { painter, container } = deps;
  try {
    // The first and last turns are always mounted, however far from the window; a jump to one of them
    // has to move the window like any other landing.
    if (!isNearViewport(painter.row(target.turnKey), container)) {
      await deps.scrollToKey(target.turnKey, { align: "start" }, navigation);
      for (let waited = 0; !painter.row(target.turnKey); waited += 1) {
        if (!navigation.isCurrent()) return "cancelled";
        if (waited >= SETTLE_MAX_FRAMES) return "missing";
        await nextFrame();
      }
    }
    if (!navigation.isCurrent()) return "cancelled";

    const locate = (): Range | null => painter.locate(target) ?? painter.locateFirstInPart(target);
    let range = locate();
    if (!range) {
      console.debug("[find] occurrence not found in the mounted row", target);
      const row = painter.row(target.turnKey);
      if (row) {
        deps.onProgrammaticScroll();
        container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - REVEAL_MARGIN;
      }
      return "revealed";
    }
    painter.setActive(target);
    bringIntoView(range, deps);

    const relativeTop = (value: Range) => value.getBoundingClientRect().top - container.getBoundingClientRect().top;
    let last = relativeTop(range);
    let stable = 0;
    for (let frame = 0; frame < SETTLE_MAX_FRAMES && stable < SETTLE_STABLE_FRAMES; frame += 1) {
      await nextFrame();
      if (!navigation.isCurrent()) return "cancelled";
      if (!range.startContainer.isConnected) {
        const again = locate();
        if (!again) break;
        range = again;
      }
      const now = relativeTop(range);
      if (Math.abs(now - last) >= 1) {
        stable = 0;
        bringIntoView(range, deps);
        last = relativeTop(range);
      } else {
        stable += 1;
      }
    }
    // The row may have remounted while settling: paint against what is mounted now.
    painter.setActive(target);
    return "revealed";
  } finally {
    navigation.end();
  }
}
