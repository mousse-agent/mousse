import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Where the find bar goes: the thread side card's layer in the thread pane, so
 * the bar shares the card's column (same top, right edge and width; sideCard.css
 * stacks the card under an open bar). A transcript outside the thread pane (the
 * Chats workspace) has no card, and its bar stays over its own top-right corner.
 */
export function findBarHost(transcript: Element | null): HTMLElement | null {
  return transcript?.closest(".sidebar")?.querySelector<HTMLElement>(":scope > .thread-side-card-layer") ?? null;
}

/** The bar in `host` when there is one, else where it is rendered. */
export function placeFindBar(bar: ReactElement, host: HTMLElement | null): ReactNode {
  return host ? createPortal(bar, host) : bar;
}
