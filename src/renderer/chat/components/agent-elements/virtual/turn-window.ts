import type { UIMessage } from "ai";
import { isRecord, isTextPart, isV5ToolPart } from "../utils/assistant-blocks";
import type { FollowMode } from "./follow-mode";

/**
 * Pure layout math for the windowed transcript. No React, no DOM: the hook in
 * `use-turn-window.ts` feeds it measurements and applies what it returns.
 *
 * Layout space: 0 is the top of row 0 inside the rows wrapper. The hook adds
 * `rowsOrigin` (the wrapper's offset inside the scroll container) to convert
 * to scroll space.
 */

/**
 * The gap between rows and spacers when the rows wrapper cannot be read. The
 * wrapper is `gap-6`, which is `1.5rem`: 21px at the app's 14px root size, so
 * the hook measures the real value and passes it to `buildLayout`.
 */
export const ROW_GAP = 24;
/** Extra pixels mounted above and below the viewport. */
export const OVERSCAN_PX = 600;
/** Middle rows; row 0 and the last row come on top, so 60 mounted at most. */
export const MAX_WINDOW_ROWS = 58;
/** Threads up to this many turns render every row, as before. */
export const RENDER_ALL_THRESHOLD = 40;
export const DEFAULT_VIEWPORT = 800;
export const SETTLE_STABLE_FRAMES = 2;
export const SETTLE_MAX_FRAMES = 60;

type TurnLike = { userMsg?: UIMessage; assistantMsgs: UIMessage[] };

/**
 * The React key of a turn. The optimistic id stays the key after the saved id
 * replaces it, so the bubble neither unmounts nor re-lands.
 */
export function resolveTurnKey(
  turn: { userMsg?: { id: string } },
  index: number,
  alias: ReadonlyMap<string, string>,
): string {
  return turn.userMsg
    ? (alias.get(turn.userMsg.id) ?? turn.userMsg.id)
    : `turn-${index}`;
}

export type TurnLayout = {
  /** The gap between neighbouring rows, spacers included. */
  gap: number;
  keys: readonly string[];
  heights: readonly number[];
  /** Top of each row in layout space. */
  offsets: readonly number[];
  total: number;
};

export function buildLayout(
  keys: readonly string[],
  measured: ReadonlyMap<string, number>,
  estimate: (key: string, index: number) => number,
  gap: number = ROW_GAP,
): TurnLayout {
  const heights: number[] = new Array(keys.length);
  const offsets: number[] = new Array(keys.length);
  let cursor = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const height = measured.get(key) ?? estimate(key, index);
    heights[index] = height;
    offsets[index] = cursor;
    cursor += height + gap;
  }
  return {
    gap,
    keys,
    heights,
    offsets,
    total: keys.length === 0 ? 0 : cursor - gap,
  };
}

/** The row containing `y`; a gap belongs to the row above it. Clamped to the rows. */
export function indexAtOffset(layout: TurnLayout, y: number): number {
  const { offsets } = layout;
  if (offsets.length === 0) return 0;
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Index of the last entry of a sorted list that is `<= y`, or -1. */
export function lastIndexAtOrBefore(sorted: readonly number[], y: number): number {
  let low = 0;
  let high = sorted.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (sorted[mid]! <= y) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export type TurnWindow = {
  /** First middle row (>= 1). */
  start: number;
  /** One past the last middle row (<= n - 1). */
  end: number;
  topSpacer: number;
  bottomSpacer: number;
};

/**
 * The middle rows to mount. Row 0 and row n-1 are always mounted outside it,
 * and `[start, end)` holds at most `maxRows` rows.
 */
export function computeWindow(
  layout: TurnLayout,
  viewportTopInLayout: number,
  viewportHeight: number,
  overscan: number = OVERSCAN_PX,
  maxRows: number = MAX_WINDOW_ROWS,
): TurnWindow {
  const n = layout.keys.length;
  if (n <= 2) {
    const edge = Math.min(1, n);
    return { start: edge, end: edge, topSpacer: 0, bottomSpacer: 0 };
  }
  let band = overscan;
  let start = 1;
  let end = 1;
  for (;;) {
    const first = indexAtOffset(layout, viewportTopInLayout - band);
    const last = indexAtOffset(layout, viewportTopInLayout + viewportHeight + band);
    start = Math.min(Math.max(first, 1), n - 1);
    end = Math.min(Math.max(last + 1, start), n - 1);
    if (end - start <= maxRows) break;
    if (band === 0) {
      end = start + maxRows;
      break;
    }
    // Shrink the overscan on both sides until the window fits.
    band = Math.floor(band / 2);
  }
  return {
    start,
    end,
    ...windowSpacers(layout, start, end),
  };
}

/** Heights of the spacers that stand in for rows `1..start-1` and `end..n-2`. */
export function windowSpacers(
  layout: TurnLayout,
  start: number,
  end: number,
): { topSpacer: number; bottomSpacer: number } {
  const n = layout.keys.length;
  if (n <= 2) return { topSpacer: 0, bottomSpacer: 0 };
  const { offsets } = layout;
  return {
    topSpacer: start > 1 ? Math.max(0, offsets[start]! - offsets[1]! - layout.gap) : 0,
    bottomSpacer:
      end < n - 1 ? Math.max(0, offsets[n - 1]! - offsets[end]! - layout.gap) : 0,
  };
}

/**
 * Keep a stored window valid when the row count changes: a window that
 * reached the last row keeps reaching it, so a new turn does not unmount the
 * row above it.
 */
export function reconcileWindow(
  stored: { start: number; end: number; n: number },
  n: number,
  maxRows: number = MAX_WINDOW_ROWS,
): { start: number; end: number } {
  if (n <= 2) {
    const edge = Math.min(1, n);
    return { start: edge, end: edge };
  }
  let { start, end } = stored;
  if (stored.n !== n && end >= stored.n - 1) end = n - 1;
  start = Math.min(Math.max(start, 1), n - 1);
  end = Math.min(Math.max(end, start), n - 1);
  if (end - start > maxRows) start = end - maxRows;
  return { start, end };
}

export type RowItem =
  | { kind: "row"; index: number }
  | { kind: "top-spacer" }
  | { kind: "bottom-spacer" };

/** Render order: row 0, top spacer, `[start, end)`, bottom spacer, last row. */
export function windowRowItems(
  n: number,
  window: { start: number; end: number },
): RowItem[] {
  if (n <= 0) return [];
  if (n === 1) return [{ kind: "row", index: 0 }];
  const items: RowItem[] = [{ kind: "row", index: 0 }];
  if (n > 2) {
    if (window.start > 1) items.push({ kind: "top-spacer" });
    for (let index = window.start; index < window.end; index += 1) {
      items.push({ kind: "row", index });
    }
    if (window.end < n - 1) items.push({ kind: "bottom-spacer" });
  }
  items.push({ kind: "row", index: n - 1 });
  return items;
}

/** A node of the reading-line search: a rect and the children in document order. */
export type AnchorNode = {
  top: number;
  bottom: number;
  children: Iterable<AnchorNode>;
};

/**
 * The node to hold still while the layout moves, by Chromium's selection rule:
 * walk the children in document order, skip those that end above the edge; the
 * first one that reaches below it is the anchor if it starts at or below the
 * edge, otherwise it straddles the edge and the search descends into it. A
 * straddling node with nothing visible inside is the anchor itself, so an
 * enclosing blockquote, list item or bubble is never chosen while a descendant
 * can be. Returns the chain from the first descent to the anchor; empty means
 * the root.
 */
export function pickAnchor<N extends AnchorNode>(
  root: N,
  viewportTop: number,
): N[] {
  const path: N[] = [];
  let current: AnchorNode = root;
  for (;;) {
    let next: N | undefined;
    for (const child of current.children) {
      if (child.bottom > viewportTop) {
        next = child as N;
        break;
      }
    }
    if (!next) return path;
    path.push(next);
    if (next.top >= viewportTop) return path;
    current = next;
  }
}

/** Which side of the picked node is held still: its top, or its bottom edge. */
export type AnchorEdge = "top" | "bottom";

/**
 * The node `pickAnchor` chooses and the edge of it to hold when no text position
 * inside it can be held. A node that starts at or below the edge is held by its
 * top. A node that straddles the edge is held by its bottom: its top does not
 * move when something inside it grows above the edge (a block that expands
 * from its placeholder, or the toolbar tail of a row whose content above it
 * grows), so holding the top lets everything below slide away, while the bottom
 * moves with all of it.
 */
export function pickReadingNode<N extends AnchorNode>(
  root: N,
  viewportTop: number,
): { node: N; edge: AnchorEdge } {
  const path = pickAnchor(root, viewportTop);
  const node = path.length > 0 ? path[path.length - 1]! : root;
  const straddles = node.top < viewportTop && node.bottom > viewportTop;
  return { node, edge: straddles ? "bottom" : "top" };
}

export type AnchorDeltaInput =
  | { posBefore: number; posAfter: number }
  | { fallback: { prev: TurnLayout; next: TurnLayout; anchorKey: string } };

/**
 * How far the held anchor moved because the layout changed. `pos` is the
 * anchor's position in scroll-content space (`rect.top - containerRect.top +
 * scrollTop`), so scrolling alone leaves it unchanged. When the anchor left the
 * document, the shift of its row stands in for it.
 */
export function anchorDelta(input: AnchorDeltaInput): number {
  if ("fallback" in input) {
    const { prev, next, anchorKey } = input.fallback;
    return offsetDeltaAbove(prev, next, anchorKey);
  }
  return input.posAfter - input.posBefore;
}

/** Shift of a row's top between two layouts: growth above it, none from the row or below. */
export function offsetDeltaAbove(
  prev: TurnLayout,
  next: TurnLayout,
  anchorKey: string,
): number {
  const before = prev.keys.indexOf(anchorKey);
  const after = next.keys.indexOf(anchorKey);
  if (before < 0 || after < 0) return 0;
  return next.offsets[after]! - prev.offsets[before]!;
}

/** `end` is `scrollHeight - clientHeight`, read from the DOM by the caller. */
export function nextScrollTop(input: {
  mode: FollowMode;
  scrollTop: number;
  delta: number;
  end: number;
}): number {
  return input.mode === "following-end"
    ? input.end
    : input.scrollTop + input.delta;
}

export type ScrollAlign = "start" | "center" | "end";

/** Scroll-space `scrollTop` that puts row `key` at `align`, or null for an unknown key. */
export function keyTargetScrollTop(
  layout: TurnLayout,
  rowsOrigin: number,
  key: string,
  align: ScrollAlign,
  viewport: number,
  offset = 0,
): number | null {
  const index = layout.keys.indexOf(key);
  if (index < 0) return null;
  const top = rowsOrigin + layout.offsets[index]!;
  const height = layout.heights[index]!;
  const target =
    align === "start"
      ? top - offset
      : align === "center"
        ? top + height / 2 - viewport / 2
        : top + height - viewport + offset;
  return Math.max(0, target);
}

export function isSettled(previous: number, next: number): boolean {
  return Math.abs(next - previous) <= 1;
}

export type SettleState = {
  frames: number;
  stable: number;
  lastTarget: number | null;
};

export const INITIAL_SETTLE: SettleState = {
  frames: 0,
  stable: 0,
  lastTarget: null,
};

/**
 * One frame of a landing. `write` is where to put `scrollTop` (null when it is
 * already there); the loop is done after `SETTLE_STABLE_FRAMES` frames in which
 * neither the target nor the position moved, or at `SETTLE_MAX_FRAMES`.
 */
export function stepSettle(
  state: SettleState,
  frame: { target: number; scrollTop: number },
): { state: SettleState; write: number | null; done: boolean; stable: boolean } {
  const targetMoved =
    state.lastTarget === null || !isSettled(state.lastTarget, frame.target);
  const away = !isSettled(frame.scrollTop, frame.target);
  const frames = state.frames + 1;
  const stableFrames = targetMoved || away ? 0 : state.stable + 1;
  const stable = stableFrames >= SETTLE_STABLE_FRAMES;
  return {
    state: { frames, stable: stableFrames, lastTarget: frame.target },
    write: away ? frame.target : null,
    done: stable || frames >= SETTLE_MAX_FRAMES,
    stable,
  };
}

/** A marker jump within this distance glides; a farther one lands instantly. */
export function shouldGlide(distance: number, viewport: number): boolean {
  return Math.abs(distance) <= 3 * viewport;
}

const BASE_TURN_HEIGHT = 96;
const LINE_HEIGHT = 24;
const CODE_LINE_HEIGHT = 20;
/** Streamdown caps a code block's body at 400px. */
const CODE_BODY_MAX = 400;
const CODE_CHROME = 56;
const IMAGE_ROW = 136;
const TOOL_ROW = 44;
const TOOLBAR = 48;
const MAX_TURN_HEIGHT = 20_000;
const USER_CHARS_PER_LINE = 90;

function isImagePart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  if (part.type === "image" || part.type === "data-image") return true;
  if (part.type !== "file") return false;
  const mime = part.mediaType ?? part.mimeType;
  return typeof mime === "string" && mime.startsWith("image/");
}

function assistantTextHeight(text: string): number {
  let height = 0;
  let fenceLines = -1;
  for (const line of text.split("\n")) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      if (fenceLines < 0) {
        fenceLines = 0;
      } else {
        height += Math.min(fenceLines * CODE_LINE_HEIGHT, CODE_BODY_MAX) + CODE_CHROME;
        fenceLines = -1;
      }
    } else if (fenceLines >= 0) {
      fenceLines += 1;
    } else {
      height += LINE_HEIGHT;
    }
  }
  if (fenceLines >= 0) {
    height += Math.min(fenceLines * CODE_LINE_HEIGHT, CODE_BODY_MAX) + CODE_CHROME;
  }
  return height;
}

/** What a turn is likely to measure, before it has been mounted once. */
export function estimateTurnHeight(turn: TurnLike): number {
  let height = BASE_TURN_HEIGHT;
  let userChars = 0;
  for (const part of turn.userMsg?.parts ?? []) {
    if (isTextPart(part)) userChars += part.text.length;
    else if (isImagePart(part)) height += IMAGE_ROW;
  }
  height += Math.ceil(userChars / USER_CHARS_PER_LINE) * LINE_HEIGHT;
  for (const message of turn.assistantMsgs) {
    for (const part of message.parts ?? []) {
      if (isTextPart(part)) height += assistantTextHeight(part.text);
      else if (isV5ToolPart(part)) height += TOOL_ROW;
    }
  }
  height += TOOLBAR;
  return Math.min(MAX_TURN_HEIGHT, Math.max(BASE_TURN_HEIGHT, height));
}
