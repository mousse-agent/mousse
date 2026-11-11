import { motionScale } from "../../../../lib/motion";
import {
  COLLAPSE_MS,
  QUEUED_TURN_HOLD_MS,
  collapsedReserve,
  heldReserve,
  heldTotalReserve,
  pinnedReserve,
} from "./end-follow";
import type { FollowMode } from "./follow-mode";

/**
 * The transcript's one writer of the scroll position while it follows the end, and the empty
 * space under the content that holds a just-sent prompt near the top (see `end-follow.ts`).
 *
 * - **Pin:** when a turn starts here, its row is held near the top of the viewport and the reply
 *   grows into the space below it. The space shrinks as fast as the reply grows, so the end, and
 *   the view, do not move. When the reply reaches the bottom the space is gone and the end is
 *   followed from there. A reader who leaves the end (a scroll, a jump to a prompt) ends the pin.
 * - **Follow:** whenever the transcript changes size, the view lands on the new end in the same
 *   frame, before paint. It never eases toward it: an eased scroll shows the reply and the queued
 *   messages under it drifting off the bottom and back on every update.
 * - **Hold:** while a turn runs, something near the end that goes away (a queued message sent into
 *   the reply, a line replaced) leaves its space under the content until the reply grows into it,
 *   so the view does not drop and come back a frame later. When a turn ends with messages still
 *   queued, the end is held the same way until the next turn starts and is pinned: one move.
 * - **Close:** a space that no longer holds a pinned prompt never stays. While the reader follows
 *   the end (the turn ended, they came back down, they asked for the latest), the part they do not
 *   see is dropped and the rest closes over a quarter of a second, so the reply settles onto the
 *   composer. A reader up in the thread keeps their view: the space only shrinks as they scroll away
 *   from it, and closes once they are back at the end.
 */
export type EndFollower = ReturnType<typeof createEndFollower>;

export function createEndFollower(options: {
  container: () => HTMLElement | null;
  rows: () => HTMLElement | null;
  mode: () => FollowMode;
  onProgrammaticScroll: () => void;
}) {
  let reserveEl: HTMLElement | null = null;
  let reserve = 0;
  /** The turn held near the top, by its row key; null when nothing is pinned. */
  let anchorKey: string | null = null;
  /** A turn is running: content that leaves near the end has its space held. */
  let live = false;
  /** The height (content and space) the transcript is held at; null when nothing is held. */
  let holdTotal: number | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** The content's height the last time the space was sized: a smaller one means something left. */
  let lastContent = 0;
  let collapseFrame = 0;

  const setReserve = (px: number) => {
    const next = Math.max(0, Math.round(px));
    if (next === reserve) return;
    reserve = next;
    if (reserveEl) reserveEl.style.height = next ? `${next}px` : "";
  };

  const offsetIn = (container: HTMLElement, el: Element) =>
    el.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop + container.scrollTop;

  /** Where the content ends: the top of the space under it. */
  const contentHeight = (container: HTMLElement) =>
    reserveEl ? offsetIn(container, reserveEl) : container.scrollHeight - reserve;

  const anchorTop = (container: HTMLElement): number | null => {
    const rows = options.rows();
    if (!rows || !anchorKey) return null;
    const key = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(anchorKey) : anchorKey;
    const row = rows.querySelector(`[data-turn-key="${key}"]`);
    return row ? offsetIn(container, row) : null;
  };

  const write = (container: HTMLElement, top: number) => {
    options.onProgrammaticScroll();
    container.scrollTop = top;
  };

  const stopCollapse = () => {
    if (collapseFrame) cancelAnimationFrame(collapseFrame);
    collapseFrame = 0;
  };

  const releaseHold = () => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    holdTotal = null;
  };

  const held = (container: HTMLElement) =>
    heldReserve({
      reserve,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      contentHeight: contentHeight(container),
    });

  /** Closes the space: what is out of sight at once, the rest eased, the view riding the end down. */
  const startCollapse = (container: HTMLElement) => {
    if (collapseFrame) return;
    setReserve(held(container));
    if (reserve === 0) return;
    const duration = COLLAPSE_MS * motionScale();
    if (duration <= 0) {
      options.onProgrammaticScroll();
      setReserve(0);
      return;
    }
    const from = reserve;
    const startedAt = performance.now();
    const step = (now: number) => {
      // The browser clamps the view to the shrinking end; marked as ours.
      options.onProgrammaticScroll();
      setReserve(collapsedReserve(from, now - startedAt, duration));
      collapseFrame = reserve > 0 ? requestAnimationFrame(step) : 0;
    };
    collapseFrame = requestAnimationFrame(step);
  };

  /**
   * Sizes the space for what is pinned or held; otherwise closes it while the end is followed, or
   * trims what no longer holds the view of a reader up in the thread.
   */
  const sizeReserve = (container: HTMLElement, content: number) => {
    const following = options.mode() === "following-end";
    if (anchorKey) {
      const top = anchorTop(container);
      if (top !== null) {
        const next = pinnedReserve({ rowTop: top, clientHeight: container.clientHeight, contentHeight: content });
        setReserve(next);
        // The reply reached the bottom of the viewport: from here the end is followed.
        if (next === 0) anchorKey = null;
        return;
      }
      anchorKey = null;
    }
    if (holdTotal !== null && !following) releaseHold();
    // Something near the end left while a turn runs at the end: hold its space for what replaces it.
    // Only for a transcript taller than the viewport; a short one does not scroll either way.
    const total = lastContent + reserve;
    if (holdTotal === null && live && following && !collapseFrame && content < lastContent - 0.5 && total > container.clientHeight) {
      holdTotal = total;
    }
    if (holdTotal !== null) {
      const next = heldTotalReserve({ total: holdTotal, contentHeight: content });
      setReserve(next);
      // The content grew back into it; a hold waiting for the next turn keeps its timer.
      if (next === 0 && holdTimer === null) holdTotal = null;
      return;
    }
    if (reserve === 0 || collapseFrame) return;
    if (following) startCollapse(container);
    else setReserve(held(container));
  };

  const updateReserve = (container: HTMLElement) => {
    const content = contentHeight(container);
    sizeReserve(container, content);
    lastContent = content;
  };

  return {
    /** The element under the content that holds the space. */
    reserveRef(el: HTMLElement | null) {
      reserveEl = el;
      if (el) el.style.height = reserve ? `${reserve}px` : "";
    },

    /** Whether a turn is running, read on every render. */
    setLive(next: boolean) {
      live = next;
    },

    /**
     * A turn the person follows has started: hold its row near the top and land there. The landing
     * is instant, as any arrival at the end of the thread is.
     */
    pin(turnKey: string) {
      const container = options.container();
      stopCollapse();
      releaseHold();
      anchorKey = turnKey;
      if (!container) return;
      updateReserve(container);
      if (options.mode() !== "following-end") return;
      const end = container.scrollHeight - container.clientHeight;
      if (Math.abs(container.scrollTop - end) >= 1) write(container, end);
    },

    /**
     * The transcript changed size (a streamed update, an image, a card opening, the viewport). Runs
     * after layout and before paint. Resizes the space, then lands on the end if following, so the
     * frame that shows the change shows it at the end.
     */
    follow() {
      const container = options.container();
      if (!container) return;
      updateReserve(container);
      if (options.mode() !== "following-end") return;
      const end = container.scrollHeight - container.clientHeight;
      if (Math.abs(container.scrollTop - end) >= 1) write(container, end);
    },

    /**
     * The turn ended: unpin, and close the space under the reply (see the summary above). With
     * messages still queued (`nextQueued`) the next turn is about to start: a reader at the end is
     * held where they are until it does, so its pin is the only move.
     */
    turnEnded(nextQueued = false) {
      live = false;
      anchorKey = null;
      releaseHold();
      const container = options.container();
      if (!container) return;
      if (nextQueued && options.mode() === "following-end") {
        stopCollapse();
        const content = contentHeight(container);
        holdTotal = content + reserve;
        lastContent = content;
        holdTimer = setTimeout(() => {
          holdTimer = null;
          holdTotal = null;
          const current = options.container();
          if (current) updateReserve(current);
        }, QUEUED_TURN_HOLD_MS);
        return;
      }
      if (reserve > 0) updateReserve(container);
    },

    /**
     * After a scroll or any input from the person, once the follow mode has taken it in: leaving the
     * end ends a pin and a hold; back at the end, a space left over closes.
     */
    settle() {
      const container = options.container();
      if (!container) return;
      const following = options.mode() === "following-end";
      if (anchorKey && !following) anchorKey = null;
      if (holdTotal !== null && !following) releaseHold();
      if (!anchorKey && holdTotal === null && reserve > 0) updateReserve(container);
    },

    /** Any input from the person: stop every motion of ours where it is. `settle` follows it. */
    cancel() {
      stopCollapse();
    },

    /** The size of the space under the content, for tests. */
    reserve: () => reserve,
    pinned: () => anchorKey,
    holding: () => holdTotal !== null,

    dispose() {
      stopCollapse();
      releaseHold();
    },
  };
}
