/**
 * Rewrites the math delimiters models emit into the `$$` form that
 * remark-math parses, outside of code. remark-math runs with single-dollar
 * math off, so `$$x$$` inside a line is inline math and a `$$` block on its
 * own lines is display math.
 *
 * - `\[ … \]`  → display block
 * - `\( … \)`  → inline
 * - `$ … $`    → inline, only when it looks like math rather than money:
 *   the opening `$` must be followed by a non-space, the closing `$` must
 *   follow a non-space and must not be followed by a digit (Pandoc's rule).
 *   "costs $5 and $10" and "$5-$10" stay plain text.
 */

const INLINE_CODE_RE = /(`+)[\s\S]*?(?<!`)\1(?!`)/g;

const DISPLAY_BRACKET_RE = /\\\[([\s\S]+?)\\\]/g;
const INLINE_PAREN_RE = /\\\(((?:(?!\n\s*\n)[\s\S])+?)\\\)/g;
const SINGLE_DOLLAR_RE = /(?<![\\$])\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<![\s\\])\$(?![\d$])/g;

function rewriteMathInText(text: string): string {
  return text
    .replace(DISPLAY_BRACKET_RE, (_match, body: string) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(INLINE_PAREN_RE, (_match, body: string) => `$$${body.trim()}$$`)
    .replace(SINGLE_DOLLAR_RE, (_match, body: string) => `$$${body}$$`);
}

/** Apply to prose only; fenced code must be split out by the caller. */
export function normalizeMathDelimiters(text: string): string {
  if (!text.includes("$") && !text.includes("\\")) return text;
  let out = "";
  let last = 0;
  INLINE_CODE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_CODE_RE.exec(text)) !== null) {
    out += rewriteMathInText(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + rewriteMathInText(text.slice(last));
}

const MATH_FENCE_RE = /^(\s*)(`{3,}|~{3,})[ \t]*math[ \t]*\n([\s\S]*?)\n?\s*\2[ \t]*$/i;

/** GitHub's ```math fence → `$$` display block. Returns null for other fences. */
export function mathFenceToDisplay(fence: string): string | null {
  const match = MATH_FENCE_RE.exec(fence);
  if (!match) return null;
  return `${match[1]}$$\n${match[3]}\n$$`;
}
