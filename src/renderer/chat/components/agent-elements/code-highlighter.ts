import type { BundledLanguage, CodeHighlighterPlugin } from "streamdown";
import type { HighlighterCore } from "shiki/core";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { countRender } from "./render-counts";

type HighlightOptions = Parameters<CodeHighlighterPlugin["highlight"]>[0];
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
type ThemeInput = HighlightOptions["themes"][number];

/** Larger blocks are shown as plain text: tokenizing them blocks the UI. */
export const MAX_HIGHLIGHT_CHARS = 20_000;
export const MAX_HIGHLIGHT_LINES = 500;
const RESULT_CACHE_LIMIT = 100;
/** While a code block streams in, it is tokenised again at most this often. */
export const STREAMING_TOKENIZE_MS = 250;

const PLAIN_LANGUAGE = "text";
// Shiki treats these as "no grammar" without loading anything.
const PLAIN_ALIASES = new Set(["text", "plaintext", "txt", "plain"]);

const DEFAULT_THEMES: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];

const languageAliases = new Map<string, string>(
  bundledLanguagesInfo.flatMap((info) =>
    (info.aliases ?? []).map((alias): [string, string] => [alias, info.id]),
  ),
);

/** Resolve a fence language or alias (`py`, `sh`) to a shiki grammar id,
 *  or "text" when there is no grammar for it. */
export function resolveHighlightLanguage(language: string): string {
  const id = String(language ?? "").trim().toLowerCase();
  if (PLAIN_ALIASES.has(id)) return PLAIN_LANGUAGE;
  const resolved = languageAliases.get(id) ?? id;
  return Object.hasOwn(bundledLanguages, resolved) ? resolved : PLAIN_LANGUAGE;
}

/** True when the block is too large to highlight. */
export function exceedsHighlightLimit(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return true;
  let lines = 1;
  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1)) {
    if (++lines > MAX_HIGHLIGHT_LINES) return true;
  }
  return false;
}

/** Unstyled tokens in the same shape Streamdown renders while it waits. */
export function plainTokens(code: string): HighlightResult {
  return {
    bg: "transparent",
    fg: "inherit",
    tokens: code.split("\n").map((line) => [
      { content: line, color: "inherit", bgColor: "transparent", htmlStyle: {}, offset: 0 },
    ]),
  };
}

const themeName = (theme: ThemeInput): string =>
  typeof theme === "string" ? theme : ((theme as { name?: string }).name ?? "custom");

// One highlighter (and one WASM engine) for the whole renderer. The highlighter
// itself loads with the first code block, not with the app; grammars load the
// first time a language is used.
let highlighterPromise: Promise<HighlighterCore> | null = null;
const languageLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/oniguruma"),
      import("shiki/themes"),
    ]).then(([{ createHighlighterCore }, { createOnigurumaEngine }, { bundledThemes }]) =>
      createHighlighterCore({
        engine: createOnigurumaEngine(import("shiki/wasm")),
        themes: [bundledThemes["github-light"], bundledThemes["github-dark"]],
      }),
    );
    // Allow a retry after a failed load instead of caching the rejection.
    highlighterPromise.catch(() => {
      highlighterPromise = null;
    });
  }
  return highlighterPromise;
}

function loadLanguage(highlighter: HighlighterCore, language: string): Promise<void> {
  let load = languageLoads.get(language);
  if (!load) {
    load = highlighter
      .loadLanguage(bundledLanguages[language as keyof typeof bundledLanguages])
      .catch((error) => {
        languageLoads.delete(language);
        throw error;
      });
    languageLoads.set(language, load);
  }
  return load;
}

const resultCache = new Map<string, HighlightResult>();

function cacheResult(key: string, result: HighlightResult): void {
  resultCache.delete(key);
  resultCache.set(key, result);
  if (resultCache.size > RESULT_CACHE_LIMIT) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
}

const pending = new Map<string, Set<(result: HighlightResult) => void>>();

type Tokenized = { code: string; result: HighlightResult };
type Line = HighlightResult["tokens"][number];

/** The block tokenised last per language and theme pair: a block growing from it is drawn from it. */
const latestByFamily = new Map<string, Tokenized>();

/** Tokenisations of growing blocks waiting for their throttle, per language and theme pair. */
const throttled = new Map<
  string,
  { code: string; lang: string; names: [string, string]; waiting: Set<(result: HighlightResult) => void> }
>();

/**
 * The text of the block growing now, per language and theme pair: the code last asked for that
 * extends it, or that started a new block. A finished block drawn again from the cache leaves it.
 */
const growing = new Map<string, string>();

function noteAsked(family: string, code: string, cached: boolean): void {
  const current = growing.get(family);
  if (current !== undefined && code.startsWith(current)) growing.set(family, code);
  else if (!cached) growing.set(family, code);
}

/** The code whose first tokenisation is under way, per language and theme pair. */
const firstPass = new Map<string, string>();

function plainToken(content: string, offset: number): Line[number] {
  return { content, color: "inherit", bgColor: "transparent", htmlStyle: {}, offset } as Line[number];
}

/**
 * `code`, which starts with `previous.code`, drawn from the tokens of `previous`: its lines keep
 * their colours, text added to its last line and new lines are plain. Nothing on screen loses its
 * colour, and nothing changes height, while the whole block waits to be tokenised again.
 */
export function extendTokens(previous: Tokenized, code: string): HighlightResult {
  const before = previous.code.split("\n");
  const last = before.length - 1;
  let offset = 0;
  const tokens = code.split("\n").map((line, index) => {
    const start = offset;
    offset += line.length + 1;
    const known = previous.result.tokens[index];
    if (index < last && known) return known;
    if (index === last && known) {
      const added = line.slice(before[last]!.length);
      return added ? [...known, plainToken(added, start + before[last]!.length)] : known;
    }
    return [plainToken(line, start)];
  });
  return { ...previous.result, tokens };
}

/**
 * Delivers `result`, tokenised from `code`. Streamdown never cancels a request, so a block that
 * has grown since it asked would be set back to the shorter text: when the code last asked for
 * grew from `code`, the result is grown to it first.
 */
function deliver(
  family: string,
  code: string,
  result: HighlightResult,
  waiting: Iterable<(result: HighlightResult) => void>,
): void {
  const asked = growing.get(family);
  let shown = result;
  if (asked && asked.length > code.length && asked.startsWith(code)) {
    // The block's newer text may be tokenised already (a finished block found in the cache).
    shown = resultCache.get(`${family}\0${asked}`) ?? extendTokens({ code, result }, asked);
  }
  for (const notify of waiting) notify(shown);
}

/** Tokenises a growing block at most every STREAMING_TOKENIZE_MS, always its latest text. */
function tokenizeSoon(
  family: string,
  code: string,
  lang: string,
  names: [string, string],
  callback: ((result: HighlightResult) => void) | undefined,
): void {
  let job = throttled.get(family);
  if (!job) {
    job = { code, lang, names, waiting: new Set() };
    throttled.set(family, job);
    const run = job;
    const timer = setTimeout(() => {
      throttled.delete(family);
      const key = `${run.lang}\0${run.names[0]}\0${run.names[1]}\0${run.code}`;
      countRender("tokenize");
      void tokenize(run.code, run.lang, run.names)
        .then(
          (result) => {
            cacheResult(key, result);
            latestByFamily.set(family, { code: run.code, result });
            return result;
          },
          () => plainTokens(run.code),
        )
        .then((result) => deliver(family, run.code, result, run.waiting));
    }, STREAMING_TOKENIZE_MS);
    (timer as { unref?: () => void }).unref?.();
  }
  job.code = code;
  if (callback) job.waiting.add(callback);
}

async function tokenize(
  code: string,
  language: string,
  themes: [string, string],
): Promise<HighlightResult> {
  const highlighter = await getHighlighter();
  let lang = language;
  if (lang !== PLAIN_LANGUAGE) {
    try {
      await loadLanguage(highlighter, lang);
    } catch {
      lang = PLAIN_LANGUAGE;
    }
  }
  return highlighter.codeToTokens(code, {
    lang,
    themes: { light: themes[0], dark: themes[1] },
  }) as HighlightResult;
}

export function createCodeHighlighter(
  themes: [ThemeInput, ThemeInput] = DEFAULT_THEMES,
): CodeHighlighterPlugin {
  return {
    name: "shiki",
    type: "code-highlighter",
    supportsLanguage: (language) => resolveHighlightLanguage(language) !== PLAIN_LANGUAGE,
    getSupportedLanguages: () => Object.keys(bundledLanguages) as BundledLanguage[],
    getThemes: () => themes,
    highlight({ code, language, themes: requested }, callback) {
      // Streamdown uses a synchronous return as the final result, so the
      // size guard answers right here and never starts any async work.
      if (exceedsHighlightLimit(code)) return plainTokens(code);

      const lang = resolveHighlightLanguage(language);
      const names: [string, string] = [themeName(requested[0]), themeName(requested[1])];
      const key = `${lang}\0${names[0]}\0${names[1]}\0${code}`;
      const family = `${lang}\0${names[0]}\0${names[1]}`;
      const cached = resultCache.get(key);
      noteAsked(family, code, cached !== undefined);
      if (cached) {
        cacheResult(key, cached);
        return cached;
      }

      // A fence still streaming in grows from the block tokenised last. It is drawn from those
      // tokens at once, and tokenised whole again at most every STREAMING_TOKENIZE_MS, instead of
      // once per delta with the new text missing until each pass ends.
      const latest = latestByFamily.get(family);
      if (latest && code.length > latest.code.length && code.startsWith(latest.code)) {
        tokenizeSoon(family, code, lang, names, callback);
        return extendTokens(latest, code);
      }
      // The block's first pass is still under way: it has no colours yet, so its text shows plain.
      const first = firstPass.get(family);
      if (first !== undefined && code.length > first.length && code.startsWith(first)) {
        tokenizeSoon(family, code, lang, names, callback);
        return plainTokens(code);
      }

      const waiting = pending.get(key);
      if (waiting) {
        if (callback) waiting.add(callback);
        return null;
      }
      const callbacks = new Set<(result: HighlightResult) => void>();
      if (callback) callbacks.add(callback);
      pending.set(key, callbacks);

      countRender("tokenize");
      firstPass.set(family, code);
      void tokenize(code, lang, names)
        .then(
          (result) => {
            cacheResult(key, result);
            latestByFamily.set(family, { code, result });
            return result;
          },
          // A grammar or engine failure leaves the block as plain text.
          () => plainTokens(code),
        )
        .then((result) => {
          pending.delete(key);
          if (firstPass.get(family) === code) firstPass.delete(family);
          deliver(family, code, result, callbacks);
        });
      return null;
    },
  };
}

/** Shared plugin for every chat code block. */
export const codeHighlighter = createCodeHighlighter();
