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
 *   followed from there.
 * - **Glide:** while a turn runs, the view eases toward the moving end, one step a frame, instead
 *   of jumping on every update. Any input from the user stops it at once. With Animation speed Off
 *   or the system reducing motion, and whenever no turn runs, it lands at once.
 * - **Collapse:** when the turn ends, the part of the space the view does not stand on is dropped
 *   (nothing on screen moves). If the reader is at the end, what is left closes over a quarter of a
 *   second, so the reply settles onto the composer instead of leaving a gap under it. A reader who
 *   scrolled up keeps their view; the space shrinks as they scroll away from it.
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

  /** Sizes the space under the content for what is pinned, or trims what no longer holds the view. */
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
    if (reserve > 0 && !collapseFrame) {
      setReserve(
        heldReserve({
          reserve,
          scrollTop: container.scrollTop,
          clientHeight: container.clientHeight,
          contentHeight: contentHeight(container),
        }),
      );
    }
  };

  const glide = (now: number) => {
    glideFrame = 0;
    const container = options.container();
    if (!container || options.mode() !== "following-end") return;
    const end = container.scrollHeight - container.clientHeight;
    const next = glideStep(container.scrollTop, end, now - glideAt, motionScale());
    glideAt = now;
    if (Math.abs(next - container.scrollTop) >= 0.5) write(container, next);
    if (Math.abs(end - container.scrollTop) >= 1) glideFrame = requestAnimationFrame(glide);
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
      live = true;
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
      if (Math.abs(container.scrollTop - end) < 1) return;
      if (!live || collapseFrame || motionScale() === 0) {
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
      if (!container || reserve === 0) return;
      const content = contentHeight(container);
      const held = heldReserve({ reserve, scrollTop: container.scrollTop, clientHeight: container.clientHeight, contentHeight: content });
      setReserve(held);
      if (held === 0 || options.mode() !== "following-end") return;
      stopGlide();
      const duration = COLLAPSE_MS * motionScale();
      if (duration <= 0) {
        options.onProgrammaticScroll();
        setReserve(0);
        return;
      }
      const from = held;
      const startedAt = performance.now();
      const step = (now: number) => {
        // The view rides the shrinking end down (the browser clamps it); marked as ours.
        options.onProgrammaticScroll();
        setReserve(collapsedReserve(from, now - startedAt, duration));
        collapseFrame = reserve > 0 ? requestAnimationFrame(step) : 0;
      };
      collapseFrame = requestAnimationFrame(step);
    },

    /** The person scrolled: a space no longer pinned shrinks to what still holds their view. */
    onScroll() {
      if (anchorKey || reserve === 0 || collapseFrame) return;
      const container = options.container();
      if (container) updateReserve(container);
    },

    /** Any input from the person: stop every motion of ours where it is. */
    cancel() {
      stopGlide();
      if (collapseFrame) {
        stopCollapse();
        const container = options.container();
        if (container) updateReserve(container);
      }
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
