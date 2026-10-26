import katex from "katex";

// Model output is untrusted: no links or other trusted commands, bounded sizes
// and macro expansion, and a failed parse falls back to the source text.
const KATEX_OPTIONS = {
  output: "htmlAndMathml",
  throwOnError: true,
  trust: false,
  strict: "ignore",
  maxSize: 20,
  maxExpand: 1000,
} as const;

const MAX_TEX_LENGTH = 20_000;
const CACHE_LIMIT = 500;

// Streaming re-renders the same formula on every delta and a failed prefix is
// as costly as a good one, so failures are cached too (as null).
const cache = new Map<string, string | null>();

/** KaTeX markup for `tex`, or null when it cannot be typeset. */
export function renderMath(tex: string, display: boolean): string | null {
  if (tex.length > MAX_TEX_LENGTH) return null;
  const key = `${display ? "d" : "i"}${tex}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  let html: string | null;
  try {
    html = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });
  } catch {
    html = null;
  }
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return html;
}
