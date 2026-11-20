import { linkLabel } from "./link-label";
import { parseThreadLink } from "../../../../shared/threadLink";

/**
 * A prompt is plain text, but people paste links into it: bare web addresses and Markdown links such as
 * `[#35130](https://github.com/o/r/pull/35130)`. The bubble shows each as a link drawn by `LinkLabel`
 * (see link-label), like a link in a reply. A thread's link (`mousse://thread/<id>`, bare, as `<…>` or as a
 * Markdown link's target) is a link too, which the bubble draws as the thread's chip; inside inline code it stays text.
 * Find reads the same labels (see find-index), so what it counts is what the bubble shows.
 */
export type PromptSegment =
  | { kind: "text"; text: string }
  /** `text` is the label as written: a Markdown link's label, or the bare address itself. */
  | { kind: "link"; text: string; href: string };

/**
 * Inline code (left as text); a Markdown link with a web or thread address; a thread address as `<…>`; a bare web
 * address; a bare thread address.
 */
const LINK_PATTERN =
  /(`[^`\n]*`)|\[([^\[\]\n]+)\]\((https?:\/\/[^\s()<>]+(?:\([^\s()<>]*\)[^\s()<>]*)*|mousse:\/\/thread\/[\w-]+(?::[\w-]+)?\/?)\)|<(mousse:\/\/thread\/[\w-]+(?::[\w-]+)?\/?)>|https?:\/\/[^\s<>"'`]+|mousse:\/\/thread\/[\w-]+(?::[\w-]+)?\/?/gi;

/** Punctuation that ends a sentence rather than the address it follows. */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

/** Trims what a bare address picks up from the sentence around it: a full stop, or a closing bracket it never opened. */
function trimBareUrl(url: string): string {
  let value = url;
  for (;;) {
    const before = value;
    value = value.replace(TRAILING_PUNCTUATION, "");
    for (const [open, close] of [["(", ")"], ["[", "]"]] as const) {
      if (value.endsWith(close) && count(value, close) > count(value, open)) value = value.slice(0, -1);
    }
    if (value === before) return value;
  }
}

function count(value: string, char: string): number {
  let found = 0;
  for (const c of value) if (c === char) found += 1;
  return found;
}

function isWebUrl(href: string): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Splits a prompt into its text and its links, in order. Without links it is one text segment. */
export function promptSegments(text: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let last = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const previous = segments[segments.length - 1];
    if (previous?.kind === "text") previous.text += value;
    else segments.push({ kind: "text", text: value });
  };
  for (const match of text.matchAll(LINK_PATTERN)) {
    if (match[1] !== undefined) continue;
    const start = match.index ?? 0;
    const markdownLabel = match[2];
    const bracketed = match[4];
    const whole = markdownLabel !== undefined || bracketed !== undefined;
    const href = markdownLabel !== undefined ? match[3]! : bracketed ?? trimBareUrl(match[0]);
    const end = whole ? start + match[0].length : start + href.length;
    if (!isWebUrl(href) && !parseThreadLink(href)) continue;
    pushText(text.slice(last, start));
    segments.push({ kind: "link", text: markdownLabel ?? href, href });
    // A bare address trimmed of its trailing punctuation leaves that punctuation as text.
    last = end;
  }
  pushText(text.slice(last));
  return segments;
}

/** The prompt's text as the bubble shows it: each link as its label. */
export function promptDisplayText(text: string): string {
  return promptSegments(text)
    .map((segment) => (segment.kind === "link" ? linkLabel(segment.href, segment.text) : segment.text))
    .join("");
}
