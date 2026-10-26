import type { BundledLanguage, CodeHighlighterPlugin } from "streamdown";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { bundledThemes } from "shiki/themes";

type HighlightOptions = Parameters<CodeHighlighterPlugin["highlight"]>[0];
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
type ThemeInput = HighlightOptions["themes"][number];

/** Larger blocks are shown as plain text: tokenizing them blocks the UI. */
export const MAX_HIGHLIGHT_CHARS = 20_000;
export const MAX_HIGHLIGHT_LINES = 500;
const RESULT_CACHE_LIMIT = 100;

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

// One highlighter (and one WASM engine) for the whole renderer. Grammars are
// loaded the first time a language is used.
let highlighterPromise: Promise<HighlighterCore> | null = null;
const languageLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createOnigurumaEngine(import("shiki/wasm")),
      themes: [bundledThemes["github-light"], bundledThemes["github-dark"]],
    });
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
      const cached = resultCache.get(key);
      if (cached) {
        cacheResult(key, cached);
        return cached;
      }

      const waiting = pending.get(key);
      if (waiting) {
        if (callback) waiting.add(callback);
        return null;
      }
      const callbacks = new Set<(result: HighlightResult) => void>();
      if (callback) callbacks.add(callback);
      pending.set(key, callbacks);

      tokenize(code, lang, names)
        .then(
          (result) => {
            cacheResult(key, result);
            return result;
          },
          // A grammar or engine failure leaves the block as plain text.
          () => plainTokens(code),
        )
        .then((result) => {
          pending.delete(key);
          for (const notify of callbacks) notify(result);
        });
      return null;
    },
  };
}

/** Shared plugin for every chat code block. */
export const codeHighlighter = createCodeHighlighter();
