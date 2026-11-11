import { motionScale } from "../../../../lib/motion";
import {
  COLLAPSE_MS,
  collapsedReserve,
  glideStep,
  heldReserve,
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
 * - **Glide:** while a turn runs, the view eases toward the moving end, one step a frame, instead
 *   of jumping on every update. Any input from the user stops it at once. With Animation speed Off
 *   or the system reducing motion, when no turn runs, and when the end is more than a screen away,
 *   it lands at once.
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
  /** A turn is running: following glides. */
  let live = false;
  let glideFrame = 0;
  let glideAt = 0;
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

  const stopGlide = () => {
    if (glideFrame) cancelAnimationFrame(glideFrame);
    glideFrame = 0;
  };

  const stopCollapse = () => {
    if (collapseFrame) cancelAnimationFrame(collapseFrame);
    collapseFrame = 0;
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
    stopGlide();
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
   * Sizes the space for what is pinned; otherwise closes it while the end is followed, or trims what
   * no longer holds the view of a reader up in the thread.
   */
  const updateReserve = (container: HTMLElement) => {
    if (anchorKey) {
      const top = anchorTop(container);
      if (top !== null) {
        const next = pinnedReserve({ rowTop: top, clientHeight: container.clientHeight, contentHeight: contentHeight(container) });
        setReserve(next);
        // The reply reached the bottom of the viewport: from here the end is followed.
        if (next === 0) anchorKey = null;
        return;
      }
      anchorKey = null;
    }
    if (reserve === 0 || collapseFrame) return;
    if (options.mode() === "following-end") startCollapse(container);
    else setReserve(held(container));
  };

  const glide = (now: number) => {
    glideFrame = 0;
    const container = options.container();
    if (!container || options.mode() !== "following-end") return;
    const end = container.scrollHeight - container.clientHeight;
    const next = glideStep(container.scrollTop, end, now - glideAt, motionScale());
    glideAt = now;
    if (next !== container.scrollTop) write(container, next);
    // The last step lands exactly on the end (glideStep returns it), whatever the pixel rounding.
    if (next !== end) glideFrame = requestAnimationFrame(glide);
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
      stopGlide();
      anchorKey = turnKey;
      if (!container) return;
      updateReserve(container);
      if (options.mode() !== "following-end") return;
      const end = container.scrollHeight - container.clientHeight;
      if (Math.abs(container.scrollTop - end) >= 1) write(container, end);
    },

    /**
     * The transcript changed size (a streamed update, an image, a card opening, the viewport). Runs
     * after layout and before paint. Resizes the space, then moves toward the end if following.
     */
    follow() {
      const container = options.container();
      if (!container) return;
      updateReserve(container);
      if (options.mode() !== "following-end") {
        stopGlide();
        return;
      }
      const end = container.scrollHeight - container.clientHeight;
      const distance = Math.abs(container.scrollTop - end);
      if (distance < 1) return;
      // More than a screen away, a glide would only stream text past the reader: land.
      if (!live || collapseFrame || motionScale() === 0 || distance > container.clientHeight) {
        stopGlide();
        write(container, end);
        return;
      }
      if (!glideFrame) {
        glideAt = performance.now();
        glideFrame = requestAnimationFrame(glide);
      }
    },

    /** The turn ended: unpin, and close the space under the reply (see the summary above). */
    turnEnded() {
      live = false;
      anchorKey = null;
      const container = options.container();
      if (container && reserve > 0) updateReserve(container);
    },

    /**
     * After a scroll or any input from the person, once the follow mode has taken it in: leaving the
     * end ends a pin; back at the end, a space left over closes.
     */
    settle() {
      const container = options.container();
      if (!container) return;
      if (anchorKey && options.mode() !== "following-end") anchorKey = null;
      if (!anchorKey && reserve > 0) updateReserve(container);
    },

    /** Any input from the person: stop every motion of ours where it is. `settle` follows it. */
    cancel() {
      stopGlide();
      stopCollapse();
    },

    /** The size of the space under the content, for tests. */
    reserve: () => reserve,
    pinned: () => anchorKey,

    dispose() {
      stopGlide();
      stopCollapse();
    },
  };
}
