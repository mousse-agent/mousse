import { REVEAL_MARGIN, type RevealNavigation } from "./find/reveal";
import { SETTLE_MAX_FRAMES, SETTLE_STABLE_FRAMES } from "./virtual/turn-window";

/** The class that briefly highlights a message the reader was taken to. */
export const LOCATED_CLASS = "is-located";
/** How long the highlight stays. Matches the animation in `app.css`. */
export const LOCATED_MS = 1600;

const PERMISSION_PREFIX = "permission:";

function escape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

/**
 * The element that shows a message: a permission request's row, a reply's first text, a prompt's
 * bubble or a notice. Null when none is mounted (a message drawn only as tool calls).
 */
export function messageElement(root: ParentNode, messageId: string): HTMLElement | null {
  const id = escape(messageId);
  const selectors = [
    ...(messageId.startsWith(PERMISSION_PREFIX)
      ? [`[data-permission-request="${escape(messageId.slice(PERMISSION_PREFIX.length))}"]`]
      : []),
    `[data-message-id="${id}"]`,
    `[data-prompt-id="${id}"]`,
    `[data-notice-id="${id}"]`,
  ];
  for (const selector of selectors) {
    const found = root.querySelector(selector);
    if (found instanceof HTMLElement) return found;
  }
  return null;
}

function turnRow(root: ParentNode, turnKey: string): HTMLElement | null {
  const found = root.querySelector(`[data-turn-key="${escape(turnKey)}"]`);
  return found instanceof HTMLElement ? found : null;
}

/** A mounted element within a viewport's height of the visible area. */
function isNearViewport(element: HTMLElement, container: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  return rect.bottom >= box.top - box.height && rect.top <= box.bottom + box.height;
}

/** Centres the element in the container unless it already shows whole; a tall one shows its top. */
function centre(element: HTMLElement, container: HTMLElement, onProgrammaticScroll: () => void): void {
  const rect = element.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  const room = box.height - 2 * REVEAL_MARGIN;
  if (rect.top >= box.top + REVEAL_MARGIN && rect.bottom <= box.bottom - REVEAL_MARGIN) return;
  const delta =
    rect.height > room
      ? rect.top - (box.top + REVEAL_MARGIN)
      : rect.top + rect.height / 2 - (box.top + box.height / 2);
  if (Math.abs(delta) < 1) return;
  onProgrammaticScroll();
  container.scrollTop += delta;
}

export type RevealMessageDeps = {
  container: HTMLElement;
  /** The column of turn rows. */
  rows: HTMLElement;
  /** Brings a turn that is not mounted into the window (long threads); absent when every turn is mounted. */
  scrollToKey?: (key: string, target: { align: "start" }) => Promise<boolean>;
  onProgrammaticScroll: () => void;
  nextFrame?: () => Promise<void>;
};

const defaultFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Takes the reader to a message of the turn `turnKey`: lands the turn when it is not mounted, centres
 * the message, and keeps it centred while late layout moves it. Resolves with the element shown, or
 * null when the navigation was cancelled (the reader scrolled) or nothing could be found.
 */
export async function revealMessage(
  target: { turnKey: string; messageId: string },
  navigation: RevealNavigation,
  deps: RevealMessageDeps,
): Promise<HTMLElement | null> {
  const nextFrame = deps.nextFrame ?? defaultFrame;
  const { container, rows } = deps;
  const find = () => messageElement(rows, target.messageId) ?? turnRow(rows, target.turnKey);
  try {
    let element = find();
    if ((!element || !isNearViewport(element, container)) && deps.scrollToKey) {
      await deps.scrollToKey(target.turnKey, { align: "start" });
      for (let waited = 0; !(element = find()); waited += 1) {
        if (!navigation.isCurrent() || waited >= SETTLE_MAX_FRAMES) return null;
        await nextFrame();
      }
    }
    if (!element || !navigation.isCurrent()) return null;
    centre(element, container, deps.onProgrammaticScroll);
    // Rows measured, code highlighted or images loaded after the landing can still move it.
    let last = element.getBoundingClientRect().top;
    let stable = 0;
    for (let frame = 0; frame < SETTLE_MAX_FRAMES && stable < SETTLE_STABLE_FRAMES; frame += 1) {
      await nextFrame();
      if (!navigation.isCurrent()) return element.isConnected ? element : null;
      if (!element.isConnected) {
        const again = find();
        if (!again) return null;
        element = again;
      }
      const now = element.getBoundingClientRect().top;
      if (Math.abs(now - last) >= 1) {
        stable = 0;
        centre(element, container, deps.onProgrammaticScroll);
        last = element.getBoundingClientRect().top;
      } else {
        stable += 1;
      }
    }
    return element;
  } finally {
    navigation.end();
  }
}

const locatedTimers = new WeakMap<HTMLElement, number>();

/** Highlights the element for a moment; showing it again restarts the highlight. */
export function flashLocated(element: HTMLElement): void {
  window.clearTimeout(locatedTimers.get(element));
  element.classList.remove(LOCATED_CLASS);
  // Restarts the animation when the same element is shown twice in a row.
  void element.offsetWidth;
  element.classList.add(LOCATED_CLASS);
  locatedTimers.set(element, window.setTimeout(() => element.classList.remove(LOCATED_CLASS), LOCATED_MS));
}
