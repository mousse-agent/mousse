import { motionScale } from "../../../../lib/motion";
import {
  COLLAPSE_MS,
  QUEUED_TURN_HOLD_MS,
  collapsedReserve,
  heldReserve,
  heldTotalReserve,
} from "./end-follow";
import type { FollowMode } from "./follow-mode";

/**
 * The transcript's one writer of the scroll position while it follows the end, and the empty
 * space under the content that holds the end in place while something near it is replaced (see
 * `end-follow.ts`).
 *
 * - **Follow:** whenever the transcript changes size, the view lands on the new end in the same
 *   frame, before paint. It never eases toward it: an eased scroll shows the reply and the queued
 *   messages under it drifting off the bottom and back on every update.
 * - **Hold:** while a turn runs, something near the end that goes away (a queued message sent into
 *   the reply, a line replaced) leaves its space under the content until the reply grows into it,
 *   so the view does not drop and come back a frame later. When a turn ends with messages still
 *   queued, the queue is held where it was painted until the next turn starts; its prompt then
 *   takes that place at the end and its reply grows from there. The turn's work folding away
 *   above it moves only what is above it, and leaves no space.
 * - **Close:** a space nothing grew into never stays. While the reader follows the end (the turn
 *   ended, they came back down, they asked for the latest), the part they do not see is dropped and
 *   the rest closes over a quarter of a second. A reader up in the thread keeps their view: the space only shrinks as they scroll away
 *   from it, and closes once they are back at the end.
 */
export type EndFollower = ReturnType<typeof createEndFollower>;

export function createEndFollower(options: {
  container: () => HTMLElement | null;
  /** What is drawn after the turns (the queued messages); null or empty when nothing is queued. */
  after?: () => HTMLElement | null;
  mode: () => FollowMode;
  onProgrammaticScroll: () => void;
}) {
  let reserveEl: HTMLElement | null = null;
  let reserve = 0;
  /** A turn is running: content that leaves near the end has its space held. */
  let live = false;
  /** The height (content and space) the transcript is held at; null when nothing is held. */
  let holdTotal: number | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** The content's height the last time the space was sized: a smaller one means something left. */
  let lastContent = 0;
  /** From the top of the queue to the end of the transcript (content and space), as last sized. */
  let lastQueueTail: number | null = null;
  /** While a turn that ended with messages queued waits for the next: the queue's tail held. */
  let queueTail: number | null = null;
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
    queueTail = null;
  };

  /** The top of the queue in scroll space; null when nothing is queued. */
  const queueTop = (container: HTMLElement): number | null => {
    const after = options.after?.();
    return after && after.childElementCount > 0 ? offsetIn(container, after) : null;
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
   * Sizes the space for what is held; otherwise closes it while the end is followed, or trims what
   * no longer holds the view of a reader up in the thread.
   */
  const sizeReserve = (container: HTMLElement, content: number) => {
    const following = options.mode() === "following-end";
    if (holdTotal !== null && !following) releaseHold();
    // Something near the end left while a turn runs at the end: hold its space for what replaces it.
    // Only for a transcript taller than the viewport; a short one does not scroll either way.
    const total = lastContent + reserve;
    if (holdTotal === null && live && following && !collapseFrame && content < lastContent - 0.5 && total > container.clientHeight) {
      holdTotal = total;
    }
    if (holdTotal !== null) {
      // Waiting for the queue's next turn: the queue keeps its place, whatever changes above it.
      const top = queueTail !== null ? queueTop(container) : null;
      if (top !== null) holdTotal = Math.max(content, top + queueTail!);
      const next = heldTotalReserve({ total: holdTotal, contentHeight: content });
      setReserve(next);
      // The content grew back into it; a hold waiting for the next turn keeps its timer.
      if (next === 0 && holdTimer === null) releaseHold();
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
    const top = queueTop(container);
    lastQueueTail = top === null ? null : content + reserve - top;
  };

  const landOnEnd = (container: HTMLElement) => {
    if (options.mode() !== "following-end") return;
    const end = container.scrollHeight - container.clientHeight;
    if (Math.abs(container.scrollTop - end) >= 1) write(container, end);
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
     * A turn the person follows has started: land on the end, where its prompt is, at once. A queue
     * held for it (`turnEnded(true)`) stops waiting; what it holds stays until the reply grows
     * into it, as with anything replaced near the end mid-turn. Any other space left under the
     * last reply goes at once, so the prompt sits on the bottom.
     */
    turnStarted() {
      stopCollapse();
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
      queueTail = null;
      const container = options.container();
      if (!container) return;
      if (holdTotal === null && reserve > 0) {
        // The browser clamps the view to the shorter end; marked as ours.
        options.onProgrammaticScroll();
        setReserve(0);
      }
      updateReserve(container);
      landOnEnd(container);
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
      landOnEnd(container);
    },

    /**
     * The turn ended: close any space left under the reply (see the summary above). With messages
     * still queued (`nextQueued`) the next turn is about to start: a reader at the end is held where
     * they are until it does.
     */
    turnEnded(nextQueued = false) {
      live = false;
      releaseHold();
      const container = options.container();
      if (!container) return;
      if (nextQueued && options.mode() === "following-end") {
        stopCollapse();
        const content = contentHeight(container);
        const top = queueTop(container);
        if (top !== null && lastQueueTail !== null) {
          // The queue stays where it was painted. The turn's work folding away and its live line
          // leaving, above it, in this commit, move only what is above it: no space opens under it.
          queueTail = lastQueueTail;
          holdTotal = Math.max(content, top + queueTail);
        } else {
          // At the end as last painted: what leaves with the turn in this commit is held too.
          holdTotal = Math.max(content, lastContent) + reserve;
        }
        lastContent = content;
        holdTimer = setTimeout(() => {
          releaseHold();
          const current = options.container();
          if (current) updateReserve(current);
        }, QUEUED_TURN_HOLD_MS);
        return;
      }
      if (reserve > 0) updateReserve(container);
    },

    /**
     * After a scroll or any input from the person, once the follow mode has taken it in: leaving the
     * end ends a hold; back at the end, a space left over closes.
     */
    settle() {
      const container = options.container();
      if (!container) return;
      if (holdTotal !== null && options.mode() !== "following-end") releaseHold();
      if (holdTotal === null && reserve > 0) updateReserve(container);
    },

    /** Any input from the person: stop every motion of ours where it is. `settle` follows it. */
    cancel() {
      stopCollapse();
    },

    /** The size of the space under the content, for tests. */
    reserve: () => reserve,
    holding: () => holdTotal !== null,

    dispose() {
      stopCollapse();
      releaseHold();
    },
  };
}
