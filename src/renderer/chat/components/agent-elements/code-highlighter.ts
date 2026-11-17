import { registerByteCache } from "../../../lib/windowCounters";
import type { BundledLanguage, CodeHighlighterPlugin } from "streamdown";
import type { HighlighterCore } from "shiki/core";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { ByteLruCache } from "../../../lib/byteLruCache";
import { countRender } from "./render-counts";

type HighlightOptions = Parameters<CodeHighlighterPlugin["highlight"]>[0];
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
type ThemeInput = HighlightOptions["themes"][number];

/** Larger blocks are shown as plain text: tokenizing them blocks the UI. */
export const MAX_HIGHLIGHT_CHARS = 20_000;
export const MAX_HIGHLIGHT_LINES = 500;
/**
 * Highlighted code kept for blocks drawn again (a row scrolled back into the window, a thread opened
 * again), by language, themes and code, bounded by an estimate of the bytes its tokens hold.
 */
export const HIGHLIGHT_CACHE_BYTES = 50 * 1024 * 1024;
/** About what one token costs beyond its text: the token object, its colours and style. */
const TOKEN_OVERHEAD_BYTES = 120;
const LINE_OVERHEAD_BYTES = 32;
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

// One highlighter (and one WASM engine) for the whole renderer. It is not part
// of the app's first paint: it loads while the window is idle after startup
// (`scheduleHighlighterWarmup`), or with the first code block if that comes
// sooner. Other grammars load the first time their language is used.
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

/** Grammars most replies use, loaded by the warm-up so their first block is coloured as it streams. */
export const WARM_LANGUAGES = ["typescript", "javascript", "tsx", "json", "shellscript", "python", "rust", "go"] as const;

/** What the warm-up needs from the window; tests pass their own. */
export type WarmupHost = {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => unknown;
  setTimeout: (callback: () => void, ms: number) => unknown;
  isHidden: () => boolean;
  /** Calls `callback` once, the next time the window is shown. */
  onceVisible: (callback: () => void) => void;
};

/** The longest an idle step waits for an idle period before it runs anyway. */
const WARMUP_IDLE_TIMEOUT_MS = 3_000;
/** Without `requestIdleCallback`, how long a step waits. */
const WARMUP_FALLBACK_DELAY_MS = 200;

const windowHost = (): WarmupHost => ({
  requestIdleCallback:
    typeof window.requestIdleCallback === "function" ? window.requestIdleCallback.bind(window) : undefined,
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  isHidden: () => document.visibilityState === "hidden",
  onceVisible: (callback) => {
    const listener = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", listener);
      callback();
    };
    document.addEventListener("visibilitychange", listener);
  },
});

/** Resolves in an idle period of a visible window; a hidden window waits until it is shown. */
function whenIdleAndVisible(host: WarmupHost): Promise<void> {
  return new Promise((resolve) => {
    const step = () => {
      if (host.isHidden()) {
        host.onceVisible(step);
        return;
      }
      resolve();
    };
    const wait = () => {
      if (host.isHidden()) {
        host.onceVisible(wait);
        return;
      }
      if (host.requestIdleCallback) host.requestIdleCallback(step, { timeout: WARMUP_IDLE_TIMEOUT_MS });
      else host.setTimeout(step, WARMUP_FALLBACK_DELAY_MS);
    };
    wait();
  });
}

let warmup: Promise<void> | null = null;

/**
 * Loads the highlighter (core, WASM engine, both themes) and then the common grammars, each in its
 * own idle period of a visible window, so no step runs while the app is busy or competes with input.
 * It shares the loads code blocks use: a block that arrives first is not loaded twice, and a later
 * block finds everything ready. Runs once; a failed step is left for the first code block to retry.
 */
export function warmHighlighterWhenIdle(host: WarmupHost = windowHost()): Promise<void> {
  warmup ??= (async () => {
    await whenIdleAndVisible(host);
    const highlighter = await getHighlighter();
    for (const language of WARM_LANGUAGES) {
      await whenIdleAndVisible(host);
      await loadLanguage(highlighter, language);
    }
  })().catch(() => undefined);
  return warmup;
}

/** Starts the warm-up once the window has painted. Tests skip it: their code blocks load on use. */
export function scheduleHighlighterWarmup(): void {
  if (import.meta.env?.MODE === "test") return;
  void warmHighlighterWhenIdle();
}

/** The estimated bytes a highlighted block holds: its text (UTF-16) and each token and line. */
export function highlightResultBytes(result: HighlightResult): number {
  let bytes = 0;
  for (const line of result.tokens) {
    bytes += LINE_OVERHEAD_BYTES;
    for (const token of line) bytes += TOKEN_OVERHEAD_BYTES + token.content.length * 2;
  }
  return bytes;
}

const resultCache = new ByteLruCache<string, HighlightResult>(HIGHLIGHT_CACHE_BYTES);

/** The highlighted-code cache, for the profiler and tests. */
export const highlightCache: Pick<ByteLruCache<string, HighlightResult>, "bytes" | "size" | "hits" | "misses" | "budgetBytes" | "clear"> =
  resultCache;

/** The cache key of `code` highlighted as `language` (a grammar id) with the light and dark themes named. */
export function highlightCacheKey(language: string, themes: readonly [string, string], code: string): string {
  return `${language}\0${themes[0]}\0${themes[1]}\0${code}`;
}

// The profiler's window breakdown reads the highlight cache's size.
registerByteCache("codeHighlight", resultCache);

function cacheResult(key: string, result: HighlightResult): void {
  // The key holds the code too.
  resultCache.set(key, result, key.length * 2 + highlightResultBytes(result));
}

type Tokenized = { code: string; result: HighlightResult };
type Line = HighlightResult["tokens"][number];
type Notify = (result: HighlightResult) => void;

/**
 * One code block as it streams in. The plugin is never told which block asks, so a block is
 * recognised by its text: a request whose code extends a stream's latest code is the same block
 * growing. Everything here is per block, so one block never shows another's code or colours.
 */
type BlockStream = {
  /** The latest code the block asked for. */
  requested: string;
  /** Its last tokenised text, which the growing block is drawn from. */
  tokenized?: Tokenized;
  /** The code of its first tokenisation, while that is under way. */
  firstPass?: string;
  /** A throttled tokenisation waiting to run, with the code it will tokenise. */
  job?: { code: string };
  /** Who waits for colours, with the code each one asked for. */
  waiting: Map<Notify, string>;
  touched: number;
};

/** The streams of one language and theme pair, newest last. A few are kept: one block streams at a time. */
const streams = new Map<string, BlockStream[]>();
const STREAMS_PER_FAMILY = 8;
let touch = 0;

/**
 * The stream `code` belongs to: the one whose latest code it extends (the longest), or a new one
 * when `create`. With `growing`, only a stream `code` makes longer.
 */
function streamFor(family: string, code: string, create: boolean, growing = false): BlockStream | undefined {
  const list = streams.get(family) ?? [];
  let found: BlockStream | undefined;
  for (const stream of list) {
    if (growing && stream.requested.length >= code.length) continue;
    if (code.startsWith(stream.requested) && (!found || stream.requested.length > found.requested.length)) found = stream;
  }
  if (!found && create) {
    found = { requested: code, waiting: new Map(), touched: 0 };
    list.push(found);
    if (list.length > STREAMS_PER_FAMILY) {
      list.sort((a, b) => a.touched - b.touched);
      list.splice(0, list.length - STREAMS_PER_FAMILY);
    }
    streams.set(family, list);
  }
  if (found) found.touched = ++touch;
  return found;
}

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
 * Delivers a block's result, tokenised from `code`. Streamdown never cancels a request, so only the
 * block's latest request is answered: an earlier one would set the block back to shorter text. It
 * gets the result when it asked for exactly `code`, or the result grown to its text when its text
 * extends `code` (the cached result for that text when there is one). Nothing longer, and nothing
 * of another block, is ever delivered.
 */
function deliver(family: string, stream: BlockStream, code: string, result: HighlightResult): void {
  for (const [notify, asked] of stream.waiting) {
    if (asked !== stream.requested) {
      stream.waiting.delete(notify);
      continue;
    }
    if (asked === code) {
      stream.waiting.delete(notify);
      notify(result);
    } else if (asked.startsWith(code)) {
      // A pass for the newer text is coming; this one only brings the colours it has.
      if (!stream.job) stream.waiting.delete(notify);
      notify(resultCache.peek(`${family}\0${asked}`) ?? extendTokens({ code, result }, asked));
    }
  }
}

/** Tokenises a growing block at most every STREAMING_TOKENIZE_MS, always its latest text. */
function tokenizeSoon(family: string, stream: BlockStream, code: string, lang: string, names: [string, string]): void {
  if (stream.job) {
    stream.job.code = code;
    return;
  }
  const job = { code };
  stream.job = job;
  const timer = setTimeout(() => {
    stream.job = undefined;
    const run = job.code;
    countRender("tokenize");
    void tokenize(run, lang, names)
      .then(
        (result) => {
          cacheResult(`${family}\0${run}`, result);
          if (!stream.tokenized || run.length >= stream.tokenized.code.length) replaceTokenized(family, stream, run, result);
          return result;
        },
        () => plainTokens(run),
      )
      .then((result) => deliver(family, stream, run, result));
  }, STREAMING_TOKENIZE_MS);
  (timer as { unref?: () => void }).unref?.();
}

/**
 * A growing block's newer pass replaces its older one. The shorter text is not asked for again, so
 * its tokens leave the cache rather than push out finished blocks.
 */
function replaceTokenized(family: string, stream: BlockStream, code: string, result: HighlightResult): void {
  const before = stream.tokenized;
  if (before && before.code !== code && code.startsWith(before.code)) resultCache.delete(`${family}\0${before.code}`);
  stream.tokenized = { code, result };
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
      const family = `${lang}\0${names[0]}\0${names[1]}`;
      const key = highlightCacheKey(lang, names, code);
      const cached = resultCache.get(key);
      if (cached) {
        // A block that reaches text already tokenised (its final text, met before) moves on to it,
        // so a late pass for its shorter text is not delivered. Another block's text leaves it.
        const stream = streamFor(family, code, false, true);
        if (stream) stream.requested = code;
        return cached;
      }

      const stream = streamFor(family, code, true)!;
      stream.requested = code;
      if (callback) stream.waiting.set(callback, code);

      // A fence still streaming in: drawn at once from its own last colours, and tokenised whole
      // again at most every STREAMING_TOKENIZE_MS, instead of once per delta with the new text
      // missing until each pass ends.
      const tokenized = stream.tokenized;
      if (tokenized && code.length > tokenized.code.length && code.startsWith(tokenized.code)) {
        tokenizeSoon(family, stream, code, lang, names);
        return extendTokens(tokenized, code);
      }
      // Its first pass is still under way: it has no colours yet, so its text shows plain.
      if (stream.firstPass !== undefined && code !== stream.firstPass) {
        tokenizeSoon(family, stream, code, lang, names);
        return plainTokens(code);
      }
      if (stream.firstPass === code) return null;

      stream.firstPass = code;
      countRender("tokenize");
      void tokenize(code, lang, names)
        .then(
          (result) => {
            cacheResult(key, result);
            if (!stream.tokenized || code.length >= stream.tokenized.code.length) replaceTokenized(family, stream, code, result);
            return result;
          },
          // A grammar or engine failure leaves the block as plain text.
          () => plainTokens(code),
        )
        .then((result) => {
          if (stream.firstPass === code) stream.firstPass = undefined;
          deliver(family, stream, code, result);
        });
      return null;
    },
  };
}

/** Shared plugin for every chat code block. */
export const codeHighlighter = createCodeHighlighter();
