"use client";

import { memo, useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { parseMarkdownIntoBlocks, Streamdown, type Components } from "streamdown";
import { Children, cloneElement, isValidElement } from "react";
import { cn } from "./utils/cn";
import { MessageImage } from "./message-image";
import { codeHighlighter } from "./code-highlighter";
import { classifyLink, routeLink, safeMarkdownUrl } from "../../../utils/chatLinks";
import { IconGitHub } from "./icons";
import { isGitHubUrl } from "./prompt-links";
import { copyMathAsTex } from "../../../markdown/math/copyMathAsTex";
import {
  hideUnclosedMathFence,
  mayContainMath,
  parseBlocksKeepingMath,
} from "../../../markdown/math/math-detect";
import { readMathClass } from "../../../markdown/math/math-markup";
import { MathInline } from "../../../markdown/math/MathView";
import { useRenderMath } from "../../../markdown/math/renderMathSetting";
import { mathRenderers, mousseMathPlugin } from "../../../markdown/math/streamdown-math";
import { mermaidRenderer } from "./markdown-mermaid";
import { CachedBlock, cachedSplit, MarkdownSetupContext } from "./markdown-cache";
import { countRender } from "./render-counts";
import { addCodeWrapToggles } from "./code-block-wrap";
import { createIncrementalNormalizer, createIncrementalSplitter } from "./streaming-markdown";

function fixNumberedListBreaks(text: string): string {
  return text.replace(/^(\d+)[.)]\s*\n+\s*/gm, "$1. ");
}

/** Keep loosely emitted list items together instead of creating separate blocks. */
function collapseLooseListGaps(text: string): string {
  return text.replace(/\n{2,}([ \t]*(?:[-*+]|\d+[.)])\s)/g, "\n$1");
}

/** Preserve fenced code exactly while normalizing prose and list whitespace. */
const MOUSSE_FILE_MARKER = "/__mousse_file_open__?";

function restoreMousseFileHref(href: string): string {
  return href.startsWith(MOUSSE_FILE_MARKER)
    ? `mousse-file://open?${href.slice(MOUSSE_FILE_MARKER.length)}`
    : href;
}

/** Characters that mean nothing to Markdown, so a backslash before one is part of the text. */
const LITERAL_AFTER_BACKSLASH = new Set(["/", '"', "'", "\\"]);
/** ASCII punctuation: what Markdown lets a backslash escape. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;
/** The text before a backslash ends inside a drive path (`C:\…`) or a network path (`\\host\…`). */
const IN_PATH = /(?:^|[^\w\\])(?:[A-Za-z]:[\\/]?|\\\\[\w.$-])\S*$/;
/** Math, where a backslash belongs to TeX: `\(`, `\[`, `\begin{` or a pair of `$`. Such a line is left as written. */
const MATH = /\\[([]|\\begin\{|\$[^$]*\$/;

/**
 * Markdown drops the backslash of an escape in prose, so `/^a\/b$/` showed as `/^a/b$/`, `\"hi\"` as
 * `"hi"`, `\\server` as `\server` and `C:\me\.cache` as `C:\me.cache`. The backslash is kept (by
 * escaping it) before `/`, `"`, `'` and `\`, which mean nothing to Markdown, and before any
 * punctuation inside a drive or network path. Other escapes still work: `\*` and `\_` show `*` and
 * `_`. Code spans, `~~~` fences, math, and indented lines (possibly indented code) are left as
 * written; ``` fences never reach here (see `normalizeMarkdown`).
 */
export function keepLiteralBackslashes(prose: string): string {
  if (!prose.includes("\\")) return prose;
  // An open code span carries over to the next line of its paragraph.
  let span = 0;
  let fence: string | null = null;
  let math = false;
  return prose
    .split("\n")
    .map((line) => {
      const marker = span ? undefined : /^ {0,3}(~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      // A display math block: from a line starting with `$$` to the one that closes it.
      if (math || /^\s*\$\$/.test(line)) {
        if ((line.match(/\$\$/g)?.length ?? 0) % 2 === 1) math = !math;
        return line;
      }
      if (!line.trim()) span = 0;
      if ((/^(?: {4}|\t)/.test(line) && !span) || MATH.test(line)) return line;
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const char = line[i]!;
        if (char === "`") {
          let run = 1;
          while (line[i + run] === "`") run++;
          if (!span) span = run;
          else if (run === span) span = 0;
          out += line.slice(i, i + run);
          i += run - 1;
          continue;
        }
        if (char !== "\\" || span) {
          out += char;
          continue;
        }
        const next = line[i + 1];
        if (next === undefined) {
          out += char;
          continue;
        }
        const literal = LITERAL_AFTER_BACKSLASH.has(next) || (ESCAPABLE.test(next) && IN_PATH.test(line.slice(0, i)));
        if (!literal) out += char + next;
        else if (next === "\\") out += "\\\\\\\\";
        else out += "\\\\" + next;
        i++;
      }
      return out;
    })
    .join("\n");
}

export function normalizeMarkdown(text: string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      // Streamdown rejects custom schemes before its component/urlTransform
      // hooks run. A same-origin marker survives sanitation and is restored by
      // the anchor renderer; fenced examples remain byte-identical.
      const protectedLinks = part.replace(/mousse-file:\/\/open\?/gi, MOUSSE_FILE_MARKER);
      return collapseLooseListGaps(fixNumberedListBreaks(keepLiteralBackslashes(protectedLinks))).replace(
        /\n{3,}/g,
        "\n\n",
      );
    })
    .join("");
}

/** Keep only the language id of a fence info string (```ts title=x → ```ts).
 *  The code plugin loads each shiki grammar on first use and falls back to
 *  plain text for ids it does not know. ```math stays math only when math is
 *  rendered. */
export function normalizeCodeFenceLanguages(text: string, keepMath: boolean): string {
  return text.replace(/```([^\n]*)/g, (_match, langRaw) => {
    const lang = String(langRaw || "")
      .trim()
      .toLowerCase()
      .split(/\s+/)[0];
    if (lang === "math" && !keepMath) return "```text";
    return lang && /^[\w#+.-]+$/.test(lang) ? `\`\`\`${lang}` : "```";
  });
}

/** True when the text ends inside a ```mermaid fence that is still open. */
function endsInOpenMermaidFence(text: string): boolean {
  if (!text.includes("mermaid")) return false;
  let open: { marker: string; mermaid: boolean } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const fence = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (!fence) continue;
    const [, marker, info] = fence;
    if (!open) {
      open = { marker, mermaid: /^mermaid(\s|$)/.test(info) };
    } else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && !info.trim()) {
      open = null;
    }
  }
  return open?.mermaid ?? false;
}

/**
 * The source's line breaks between a list item's or a quote's blocks arrive as "\n" text. Prose
 * keeps single newlines as line breaks (white-space: pre-line), so one of those between blocks
 * would draw an empty line; they carry nothing, so they are dropped.
 */
const BLOCK_TAGS = new Set(["p", "ul", "ol", "pre", "blockquote", "table", "div", "h1", "h2", "h3", "h4", "h5", "h6", "hr"]);

function isBlock(part: ReactNode): boolean {
  if (!isValidElement<{ node?: { tagName?: unknown } }>(part)) return false;
  const tag = typeof part.type === "string" ? part.type : part.props.node?.tagName;
  return typeof tag === "string" && BLOCK_TAGS.has(tag);
}

function withoutBreaksBetweenBlocks(children: ReactNode): ReactNode {
  const parts = Children.toArray(children);
  if (!parts.some(isBlock)) return children;
  return parts.filter(
    (part, index) =>
      typeof part !== "string" || part.trim() !== "" || !(isBlock(parts[index - 1]) || isBlock(parts[index + 1])),
  );
}

const ALERT_KINDS = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
} as const;
type AlertKind = keyof typeof ALERT_KINDS;

// The marker must own its line, as on GitHub: `> [!NOTE] text` stays a quote.
const ALERT_MARKER_RE = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

/** GitHub alert syntax: a blockquote whose first line is `[!NOTE]` etc.
 *  Returns the kind and the children with the marker removed. */
function splitAlert(children: ReactNode): { kind: AlertKind; body: ReactNode[] } | null {
  const parts = Children.toArray(children);
  const firstIndex = parts.findIndex((part) => typeof part !== "string" || part.trim() !== "");
  const first = parts[firstIndex];
  if (!isValidElement<{ children?: ReactNode }>(first)) return null;
  const inner = Children.toArray(first.props.children);
  const lead = inner[0];
  if (typeof lead !== "string") return null;
  const match = ALERT_MARKER_RE.exec(lead);
  if (!match) return null;
  const rest = [lead.slice(match[0].length), ...inner.slice(1)].filter((part) => part !== "");
  const body = parts.slice(firstIndex + 1);
  if (rest.length > 0) body.unshift(cloneElement(first, undefined, ...rest));
  return { kind: match[1].toLowerCase() as AlertKind, body };
}

export type MarkdownProps = {
  content: string;
  className?: string;
  textContrast?: "normal" | "high";
  /**
   * The text is a reply still streaming in. Only its live tail is normalised and split again on
   * each update, and blocks that appear fade in. Off for everything already written.
   */
  streaming?: boolean;
};

/** Splits text into blocks as Streamdown does, counting the blocks it splits (see render-counts). */
function splitBlocks(text: string): string[] {
  const blocks = parseMarkdownIntoBlocks(text);
  countRender("blocksSplit", blocks.length);
  return blocks;
}

// A finished reply splits the same way each time it is drawn: kept in the markdown cache. A reply
// still streaming changes on every update, so its splits are not kept.
const splitFinished = cachedSplit("plain", splitBlocks);
const splitFinishedWithMath = cachedSplit("math", parseBlocksKeepingMath);

function normalizeText(text: string): string {
  return normalizeCodeFenceLanguages(normalizeMarkdown(text), false);
}

/** One incremental normaliser and splitter for the reply this Markdown shows while it streams. */
function useLiveMarkdown() {
  const live = useRef<{ normalize: (text: string) => string; split: (text: string) => string[] } | null>(null);
  live.current ??= {
    normalize: createIncrementalNormalizer(normalizeText),
    split: createIncrementalSplitter(splitBlocks),
  };
  return live.current;
}

// Same reason as `markdownComponents` below: a fresh `{ code }` wrapper per
// render would defeat memoization inside Streamdown. Streamdown keeps one
// processor per distinct plugin list, so there are exactly two: with math and
// without it.
const markdownPlugins = { code: codeHighlighter, renderers: [mermaidRenderer] };
const markdownMathPlugins = {
  code: codeHighlighter,
  math: mousseMathPlugin,
  renderers: [...mathRenderers, mermaidRenderer],
};
/**
 * Closes a `code` span left open at the end of a reply that is still streaming, as Markdown reads
 * it: a backslash escapes only outside a code span, so `` `C:\dir\` `` and `` `\\` `` are closed
 * spans. Fenced code and earlier paragraphs are left alone (an open span ends at a blank line).
 */
export function completeInlineCode(text: string): string {
  let fence: string | null = null;
  let open = 0;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
      continue;
    }
    if (marker && !open) {
      fence = marker;
      continue;
    }
    if (!line.trim()) {
      open = 0;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === "\\" && !open) {
        i++;
        continue;
      }
      if (char !== "`") continue;
      let run = 1;
      while (line[i + run] === "`") run++;
      if (!open) open = run;
      else if (run === open) open = 0;
      i += run - 1;
    }
  }
  return open && !fence ? text + "`".repeat(open) : text;
}

// Math is typeset by our own components. Streamdown's own completion of an
// unclosed `$$` would otherwise rewrite the text before our parser sees it.
// Its inline code completion reads a backslash inside a span as an escape and
// adds a stray backtick after `` `C:\dir\` ``; ours follows Markdown.
const markdownRemend = {
  katex: false,
  inlineCode: false,
  handlers: [{ name: "inline-code", handle: completeInlineCode }],
};
// Navigation is synchronously allowlisted by safeMarkdownUrl/classifyLink and
// handled inside Mousse; disable Streamdown's HTTP-only interstitial so the
// canonical mousse-file scheme reaches our anchor renderer.
const markdownLinkSafety = { enabled: false };
// Code blocks offer Copy only: saving a snippet as a file is rare, and the agent writes files itself.
// (Wrap is added beside it, see code-block-wrap.ts.)
const markdownControls = { code: { copy: true, download: false } };
// A tall block shows this much and scrolls inside.
const CODE_BLOCK_MAX_HEIGHT = 640;

function renderInlineCode(children: ReactNode, props: ComponentProps<"code">): ReactNode {
  return (
    <code className="an-md-code" {...props}>
      {children}
    </code>
  );
}

// Hoisted to module scope on purpose: defining these inline per render
// gives every Markdown a brand-new `components` identity, which forces
// Streamdown to reconcile + re-run shiki highlighting for ALL code blocks
// on ANY parent re-render (e.g. prompt-marker updates after an
// expand/collapse resize). Stable identity keeps unrelated re-renders cheap.
const markdownComponents: Components = {
  // Sizes, spacing and colours live in agent-ui.css (`.an-markdown .an-md-*`), so the rhythm of a
  // reply is set in one place and a caller's text size cannot change it.
  h1: ({ children, ...props }) => (
    <h1 className="an-md-h1" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="an-md-h2" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="an-md-h3" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="an-md-h4" {...props}>
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p className="an-md-p" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="an-md-ul list-outside" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="an-md-ol list-decimal list-outside" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="an-md-li" {...props}>
      {withoutBreaksBetweenBlocks(children)}
    </li>
  ),
  // Inline code is plain text on a light tint: no border and no token colours, so it reads as part
  // of the sentence. (Block code goes through the code plugin.)
  inlineCode: ({ children, ...props }) => renderInlineCode(children, props),
  strong: ({ children, ...props }) => (
    <strong className="an-md-strong" {...props}>
      {children}
    </strong>
  ),
  a: ({ href, children, ...props }) => {
    if (!href) return <span>{children}</span>;
    const routedHref = restoreMousseFileHref(href);
    if (classifyLink(routedHref).kind === "reject") return <span>{children}</span>;
    return (
      <a
        {...props}
        href={routedHref}
        onClick={(event) => { event.preventDefault(); routeLink(routedHref); }}
        className="an-md-link"
      >
        {isGitHubUrl(routedHref) && <IconGitHub className="an-md-link-icon" />}
        {children}
      </a>
    );
  },
  blockquote: ({ children, ...props }) => {
    const alert = splitAlert(children);
    if (alert) {
      const title = ALERT_KINDS[alert.kind];
      return (
        <div
          className={`an-md-alert an-md-alert-${alert.kind} my-3 pl-3 border-l-2`}
          role="note"
          aria-label={title}
        >
          <p className="an-md-alert-title text-sm font-medium mb-1">{title}</p>
          {alert.body}
        </div>
      );
    }
    return (
      <blockquote
        className="an-md-blockquote"
        {...props}
      >
        {withoutBreaksBetweenBlocks(children)}
      </blockquote>
    );
  },
  hr: ({ ...props }) => (
    <hr className="an-md-hr border-an-border-color" {...props} />
  ),
  // Images open large on click or Enter, in place of Streamdown's hover download button.
  img: (props) => <MessageImage {...props} />,
  // A table has no frame or header fill: a hairline under each row, the first and last columns
  // flush with the prose.
  table: ({ children, ...props }) => (
    <div className="an-md-table-wrap overflow-x-auto">
      <table className="an-md-table" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th className="an-md-th" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="an-md-td" {...props}>
      {children}
    </td>
  ),
};

// Inline math arrives as inline code tagged by remarkMousseMath.
const markdownMathComponents: Components = {
  ...markdownComponents,
  inlineCode: ({ children, ...props }) => {
    const math = readMathClass(props.className);
    if (!math) return renderInlineCode(children, props);
    const tex = Children.toArray(children).join("");
    return <MathInline tex={tex} display={math.display} delimiter={math.delimiter} />;
  },
};

export const Markdown = memo(function Markdown({ content, className, streaming = false }: MarkdownProps) {
  countRender("Markdown");
  const renderMath = useRenderMath();
  const math = renderMath && mayContainMath(content);
  const live = useLiveMarkdown();
  // Math has a split of its own and is worked on whole; the live tail gives the same text and
  // blocks as the whole would, so the end of the stream changes nothing on screen.
  const incremental = streaming && !math;
  const safeContent = incremental
    ? live.normalize(content)
    : normalizeCodeFenceLanguages(normalizeMarkdown(math ? hideUnclosedMathFence(content) : content), math);

  // Streamdown reports a fence as unfinished (`isIncomplete`) only while
  // `isAnimating`, and Markdown is not told whether a reply is streaming. An
  // open mermaid fence is the one case that must not be drawn half-written, so
  // derive it from the text. Limited to mermaid because `isAnimating` also
  // disables every code block's copy button.
  const drawingDiagram = endsInOpenMermaidFence(safeContent);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (root.current) addCodeWrapToggles(root.current);
  });

  return (
    <div
      ref={root}
      className={cn(
        "an-markdown",
        "overflow-hidden wrap-break-word",
        "[&_li>p]:inline [&_li>p]:mb-0",
        className,
      )}
      onCopy={math ? copyMathAsTex : undefined}
      data-streaming={streaming || undefined}
    >
      <MarkdownSetupContext.Provider value={math ? "math" : "plain"}>
      <Streamdown
        components={math ? markdownMathComponents : markdownComponents}
        plugins={math ? markdownMathPlugins : markdownPlugins}
        BlockComponent={CachedBlock}
        parseMarkdownIntoBlocksFn={
          math
            ? streaming ? parseBlocksKeepingMath : splitFinishedWithMath
            : incremental ? live.split : splitFinished
        }
        // Only a reply still being written has unfinished Markdown to complete; finished text is read as written.
        parseIncompleteMarkdown={streaming}
        remend={markdownRemend}
        codeBlockMaxHeight={CODE_BLOCK_MAX_HEIGHT}
        isAnimating={drawingDiagram}
        urlTransform={safeMarkdownUrl}
        linkSafety={markdownLinkSafety}
        controls={markdownControls}
      >
        {safeContent}
      </Streamdown>
      </MarkdownSetupContext.Provider>
    </div>
  );
});
