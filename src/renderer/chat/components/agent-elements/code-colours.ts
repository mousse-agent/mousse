import type { CodeHighlighterPlugin } from "streamdown";

/**
 * Syntax colours for code blocks (code-block.tsx), as few nodes as the colours need.
 *
 * Streamdown drew each token as a span with an inline style. Here neighbouring tokens of one colour are one run,
 * whitespace joins the run before it, and a run's colours are a class shared by every run of those colours, with a
 * rule for the light theme and one for the dark. Nothing has an inline style, so Chromium shares their styles.
 *
 * Also here: whether a block is near the viewport, since only blocks near it are coloured.
 */

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
export type TokenLine = HighlightResult["tokens"][number];
type Token = TokenLine[number];

/** A token's colours: what Streamdown's token span showed in the light theme and in the dark. */
type TokenStyle = { light: string; dark: string; lightBg?: string; darkBg?: string };

const usable = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && value !== "inherit" && value !== "transparent";

/**
 * The colours a token was drawn with: its colour (`color` in its style, else `color`), the dark theme's from
 * `--shiki-dark`, and a background only when it has one. A token without a colour of its own (plain text, the
 * uncoloured tail of a block still streaming) inherits the block's colour.
 */
function tokenStyle(token: Token): TokenStyle | null {
  const style = (token.htmlStyle ?? {}) as Record<string, string | undefined>;
  const light = usable(style.color) ? style.color : usable(token.color) ? token.color : undefined;
  if (!light) return null;
  const dark = usable(style["--shiki-dark"]) ? style["--shiki-dark"] : light;
  const lightBg = usable(style["background-color"]) ? style["background-color"] : usable(token.bgColor) ? token.bgColor : undefined;
  const darkBg = lightBg ? (usable(style["--shiki-dark-bg"]) ? style["--shiki-dark-bg"] : lightBg) : undefined;
  return lightBg ? { light, dark, lightBg, darkBg } : { light, dark };
}

const styleKey = (style: TokenStyle) => `${style.light}|${style.dark}|${style.lightBg ?? ""}|${style.darkBg ?? ""}`;

/** One run of a line to colour: [start, end) in the line's text, with its colours. */
export type ColourRun = { start: number; end: number; style: TokenStyle };

/**
 * The runs to colour in one line: neighbouring tokens of the same colours become one run, and whitespace without a
 * background joins the run before it or is left out (its colour does not show). `null` when the tokens do not spell
 * `text`: they belong to another version of the line, which then stays uncoloured rather than coloured wrongly.
 */
export function colourRuns(line: TokenLine, text: string): ColourRun[] | null {
  const runs: Array<ColourRun & { key: string }> = [];
  let at = 0;
  let open: (ColourRun & { key: string }) | null = null;
  for (const token of line) {
    const content = token.content;
    if (!text.startsWith(content, at)) return null;
    const start = at;
    at += content.length;
    if (content === "") continue;
    const style = tokenStyle(token);
    if (!style) {
      open = null;
      continue;
    }
    if (!style.lightBg && content.trim() === "") {
      if (open) open.end = at;
      continue;
    }
    const key = styleKey(style);
    if (open && open.key === key && open.end === start) {
      open.end = at;
      continue;
    }
    open = { start, end: at, style, key };
    runs.push(open);
  }
  if (at !== text.length) return null;
  return runs.map(({ start, end, style }) => ({ start, end, style }));
}

/** A piece of a line: its text, and the class of its colours when it has any. */
export type Piece = { text: string; colour?: string };

/** The whole line in pieces: its coloured runs and the plain text between them. `null` as for `colourRuns`. */
export function linePieces(line: TokenLine, text: string): Piece[] | null {
  const runs = colourRuns(line, text);
  if (!runs) return null;
  const pieces: Piece[] = [];
  let at = 0;
  for (const run of runs) {
    if (run.start > at) pieces.push({ text: text.slice(at, run.start) });
    pieces.push({ text: text.slice(run.start, run.end), colour: colourClass(run.style) });
    at = run.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

// ---------------------------------------------------------------------------------------------------------------
// The colour classes: one per distinct pair of colours, with its rules.

const CLASS_PREFIX = "an-tok-";
const classes = new Map<string, { name: string; style: TokenStyle }>();
let sheet: CSSStyleSheet | null = null;

/** A CSS colour from the theme, or nothing when it is not one (it is never written into a rule otherwise). */
const cssColour = (value: string | undefined): string | undefined =>
  value && typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("color", value) ? value : undefined;

function declarations(color: string | undefined, background: string | undefined): string {
  const parts: string[] = [];
  if (color) parts.push(`color: ${color}`);
  if (background) parts.push(`background-color: ${background}`);
  return parts.join("; ");
}

/**
 * The rules for one class. The dark rule uses the same test as the `dark` variant in global.css: every theme but
 * Light is dark, and System follows the OS. Streamdown's token spans used that variant.
 */
function writeRules(target: CSSStyleSheet, name: string, style: TokenStyle): void {
  const light = declarations(cssColour(style.light), cssColour(style.lightBg));
  const dark = declarations(cssColour(style.dark), cssColour(style.darkBg));
  const selector = `.${name}`;
  try {
    if (light) target.insertRule(`${selector} { ${light}; }`, target.cssRules.length);
    if (dark) {
      target.insertRule(`html:not([data-theme='light']):not([data-theme='system']) ${selector} { ${dark}; }`, target.cssRules.length);
      target.insertRule(`@media (prefers-color-scheme: dark) { html[data-theme='system'] ${selector} { ${dark}; } }`, target.cssRules.length);
    }
  } catch {
    // A rule the stylesheet refuses leaves those runs in the block's own colour.
  }
}

/** The stylesheet with every class's colours. A page that lost it (a test clearing the document) gets it again. */
function ruleSheet(): CSSStyleSheet | null {
  if (sheet?.ownerNode?.isConnected) return sheet;
  if (typeof document === "undefined") return null;
  const element = document.createElement("style");
  element.dataset.mousseCodeColours = "";
  document.head.append(element);
  sheet = element.sheet;
  if (sheet) for (const entry of classes.values()) writeRules(sheet, entry.name, entry.style);
  return sheet;
}

/** The class for a pair of colours, made (with its rules) the first time it is asked for. */
function colourClass(style: TokenStyle): string {
  const key = styleKey(style);
  let entry = classes.get(key);
  if (!entry) {
    const hadSheet = sheet?.ownerNode?.isConnected === true;
    entry = { name: `${CLASS_PREFIX}${classes.size}`, style };
    classes.set(key, entry);
    // A new sheet is written whole, this class included.
    const target = ruleSheet();
    if (target && hadSheet) writeRules(target, entry.name, entry.style);
  }
  return entry.name;
}

// ---------------------------------------------------------------------------------------------------------------
// Near the viewport: one observer for every block.

/** How far outside the viewport (and outside each scrolling area) a block is coloured. */
const NEAR_MARGIN_PX = 600;

const watchers = new WeakMap<Element, (near: boolean) => void>();
let observer: IntersectionObserver | null = null;

function sharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!observer) {
    const margin = `${NEAR_MARGIN_PX}px 0px`;
    // `scrollMargin` grows each scrolling area a block sits in (the transcript), not only the window, so a block
    // is coloured before it scrolls into view.
    const options = { rootMargin: margin, scrollMargin: margin } as IntersectionObserverInit;
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting);
    }, options);
  }
  return observer;
}

/** True when `element` is laid out within NEAR_MARGIN_PX of the window: the guess used until the observer reports. */
export function nearViewportNow(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const height = typeof window === "undefined" ? 0 : window.innerHeight;
  return rect.bottom >= -NEAR_MARGIN_PX && rect.top <= height + NEAR_MARGIN_PX;
}

/** Calls `onChange` when `element` comes near the viewport or leaves it. Returns the stop. */
export function watchNearViewport(element: Element, onChange: (near: boolean) => void): () => void {
  const shared = sharedObserver();
  if (!shared) return () => undefined;
  watchers.set(element, onChange);
  shared.observe(element);
  return () => {
    watchers.delete(element);
    shared.unobserve(element);
  };
}
