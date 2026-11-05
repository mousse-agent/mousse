/**
 * Whether the transcript sticks to the end of the thread, as a pure reducer
 * over what the user does. A scroll position alone never decides it: the
 * previous heuristic (scrollTop went down, so the user left) misfired on every
 * programmatic write and layout shift.
 */
export type FollowMode = "following-end" | "free";

export type Intent = "scroll-away" | "scroll-toward" | null;

/** Where keyboard focus is, as far as paging keys care. */
export type KeyFocus = "container" | "body" | "editable" | "other";

export type IntentInput =
  | {
      type: "wheel";
      deltaY: number;
      ctrlKey: boolean;
      metaKey: boolean;
      overflowing: boolean;
    }
  | {
      type: "pointerdown";
      /** The press landed on the container itself, not on a child. */
      onContainer: boolean;
      offsetX: number;
      clientWidth: number;
      overflowing: boolean;
    }
  | {
      type: "keydown";
      key: string;
      ctrlKey: boolean;
      metaKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
      focus: KeyFocus;
      overflowing: boolean;
    }
  | { type: "touchmove"; atBottom: boolean; overflowing: boolean };

const AWAY_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);
const TOWARD_KEYS = new Set(["PageDown", "End", "ArrowDown"]);

/** What a raw input means for following. Content that fits never yields an intent. */
export function classifyIntent(input: IntentInput): Intent {
  if (!input.overflowing) return null;
  switch (input.type) {
    case "wheel":
      if (input.ctrlKey || input.metaKey) return null;
      if (input.deltaY < 0) return "scroll-away";
      if (input.deltaY > 0) return "scroll-toward";
      return null;
    case "pointerdown":
      // Only a press on the vertical scrollbar; a click in the gutter is not a scroll.
      return input.onContainer &&
        (input.offsetX >= input.clientWidth || input.offsetX < 0)
        ? "scroll-away"
        : null;
    case "keydown":
      if (input.ctrlKey || input.metaKey || input.altKey || input.shiftKey) {
        return null;
      }
      if (input.focus !== "container" && input.focus !== "body") return null;
      if (AWAY_KEYS.has(input.key)) return "scroll-away";
      if (TOWARD_KEYS.has(input.key)) return "scroll-toward";
      return null;
    case "touchmove":
      return input.atBottom ? null : "scroll-away";
  }
}

export type FollowEvent =
  | { type: "intent"; intent: Intent }
  | { type: "scroll"; atBottom: boolean; programmatic: boolean }
  | { type: "new-turn" }
  | { type: "jump-to-latest" }
  | { type: "navigate" }
  | { type: "thread-open"; initial: "bottom" | "top" };

/**
 * How far from the end (px) the reader must be before the composer folds to
 * one line. Folding gives back about 30px of list padding, which can pull the
 * scroll position toward the end; this sits far enough past the 80px follow
 * threshold that it never lands back within it and unfolds the composer again.
 */
export const COMPOSER_FOLD_DISTANCE = 120;

/**
 * Whether the composer is folded while the reader browses earlier messages.
 * Following the end always unfolds it; between the follow threshold and
 * `COMPOSER_FOLD_DISTANCE` it keeps its state, so it never flickers there.
 */
export function nextComposerCompact(
  compact: boolean,
  input: { mode: FollowMode; distanceFromEnd: number },
): boolean {
  if (input.mode === "following-end") return false;
  if (input.distanceFromEnd > COMPOSER_FOLD_DISTANCE) return true;
  return compact;
}

export function reduceFollow(mode: FollowMode, event: FollowEvent): FollowMode {
  switch (event.type) {
    case "intent":
      return event.intent === "scroll-away" ? "free" : mode;
    case "scroll":
      if (event.programmatic) return mode;
      return event.atBottom ? "following-end" : "free";
    case "new-turn":
    case "jump-to-latest":
      return "following-end";
    case "navigate":
      return "free";
    case "thread-open":
      return event.initial === "bottom" ? "following-end" : "free";
  }
}
