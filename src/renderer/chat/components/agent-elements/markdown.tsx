"use client";

import { memo, type ReactNode } from "react";
import { Streamdown, type Components } from "streamdown";
import { Children, cloneElement, isValidElement } from "react";
import { cn } from "./utils/cn";
import { codeHighlighter } from "./code-highlighter";
import { classifyLink, routeLink, safeMarkdownUrl } from "../../../utils/chatLinks";

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

function normalizeMarkdown(text: string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      // Streamdown rejects custom schemes before its component/urlTransform
      // hooks run. A same-origin marker survives sanitation and is restored by
      // the anchor renderer; fenced examples remain byte-identical.
      const protectedLinks = part.replace(/mousse-file:\/\/open\?/gi, MOUSSE_FILE_MARKER);
      return collapseLooseListGaps(fixNumberedListBreaks(protectedLinks)).replace(
        /\n{3,}/g,
        "\n\n",
      );
    })
    .join("");
}

/** Keep only the language id of a fence info string (```ts title=x → ```ts).
 *  The code plugin loads each shiki grammar on first use and falls back to
 *  plain text for ids it does not know. */
function normalizeCodeFenceLanguages(text: string): string {
  return text.replace(/```([^\n]*)/g, (_match, langRaw) => {
    const lang = String(langRaw || "")
      .trim()
      .toLowerCase()
      .split(/\s+/)[0];
    return lang && /^[\w#+.-]+$/.test(lang) ? `\`\`\`${lang}` : "```";
  });
}

/** Lightweight synchronous tokenizer for inline `code` chips.
 *  Full shiki per chip is async + far too heavy (see perf note on
 *  `markdownComponents`); inline snippets have no language tag anyway.
 *  This highlights the shapes that actually appear in chat — quoted
 *  strings, numbers, JS/TS keywords, and `fn()` calls — leaving file
 *  paths and plain identifiers in the chip's base color. */
const INLINE_KW = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "return",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);

const INLINE_TOKEN_RE =
  /("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|\b\d+(?:\.\d+)?\b|\b(?:as|async|await|break|case|catch|class|const|continue|default|delete|else|enum|export|extends|false|finally|for|from|function|if|implements|import|in|instanceof|interface|let|new|null|return|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield)\b|[A-Za-z_$][\w$]*(?=\())/g;

function tokenizeInlineCode(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  INLINE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const first = tok[0];
    let cls: string;
    if (first === '"' || first === "'" || first === "`") cls = "tok-str";
    else if (first >= "0" && first <= "9") cls = "tok-num";
    else if (INLINE_KW.has(tok)) cls = "tok-kw";
    else cls = "tok-fn";
    out.push(
      <span key={key++} className={cls}>
        {tok}
      </span>,
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Tokenize only when children are plain text; otherwise pass through. */
function renderInlineChildren(children: ReactNode): ReactNode {
  const parts = Children.toArray(children);
  if (!parts.every((p) => typeof p === "string" || typeof p === "number"))
    return children;
  const text = parts.join("");
  if (!text) return children;
  return tokenizeInlineCode(text);
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
};

// Same reason as `markdownComponents` below: a fresh `{ code }` wrapper per
// render would defeat memoization inside Streamdown.
const markdownPlugins = { code: codeHighlighter };
// Navigation is synchronously allowlisted by safeMarkdownUrl/classifyLink and
// handled inside Mousse; disable Streamdown's HTTP-only interstitial so the
// canonical mousse-file scheme reaches our anchor renderer.
const markdownLinkSafety = { enabled: false };

// Hoisted to module scope on purpose: defining these inline per render
// gives every Markdown a brand-new `components` identity, which forces
// Streamdown to reconcile + re-run shiki highlighting for ALL code blocks
// on ANY parent re-render (e.g. prompt-marker updates after an
// expand/collapse resize). Stable identity keeps unrelated re-renders cheap.
const markdownComponents: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="an-md-h1 text-xl font-semibold mt-5 mb-2 leading-snug" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="an-md-h2 text-lg font-semibold mt-4 mb-2 leading-snug" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="an-md-h3 text-base font-semibold mt-4 mb-1.5" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="an-md-h4 text-base font-medium mt-3 mb-1.5" {...props}>
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p
      className="an-md-p text-base leading-relaxed text-an-foreground/80"
      {...props}
    >
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul
      className="an-md-ul list-disc list-outside space-y-1.5 text-base my-2 pl-5 text-an-foreground/80"
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol
      className="an-md-ol list-decimal list-outside space-y-1.5 text-base my-2 pl-5 text-an-foreground/80"
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="an-md-li text-base pl-1 text-an-foreground/80" {...props}>
      {children}
    </li>
  ),
  // Streamdown's default inline code is a roomy `px-1.5` pill that reads
  // like stray spaces in `( code )`. Keep it compact and on-theme so it
  // hugs the code text, in the Git diff console font, with lightweight
  // token highlighting (strings / numbers / keywords / fn calls).
  // (Block code still goes through the code plugin.)
  inlineCode: ({ children, ...props }) => (
    <code
      className="an-md-code rounded border border-an-border-color bg-an-tool-background px-1 py-px text-[0.85em] text-an-foreground"
      {...props}
    >
      {renderInlineChildren(children)}
    </code>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-medium text-an-foreground" {...props}>
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
        className="an-md-link hover:underline underline-offset-2 text-an-primary-color"
      >
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
        className="an-md-blockquote pl-3 italic mb-2 text-base border-l-2 border-an-border-color text-an-foreground/70"
        {...props}
      >
        {children}
      </blockquote>
    );
  },
  hr: ({ ...props }) => (
    <hr className="an-md-hr my-4 border-an-border-color" {...props} />
  ),
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto my-3 border border-an-border-color rounded-an-tool-border-radius">
      <table
        className="an-md-table w-full text-base [&>thead]:bg-an-tool-background [&>thead>tr>th]:bg-an-tool-background"
        {...props}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th
      className="text-left font-medium px-3 py-2 bg-an-background-secondary"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td
      className="px-3 py-2 border-t border-an-border-color text-an-foreground/80"
      {...props}
    >
      {children}
    </td>
  ),
};

export const Markdown = memo(function Markdown({ content, className }: MarkdownProps) {
  const safeContent = normalizeCodeFenceLanguages(
    normalizeMarkdown(content),
  );

  return (
    <div
      className={cn(
        "an-markdown",
        "overflow-hidden wrap-break-word",
        "[&_li>p]:inline [&_li>p]:mb-0",
        className,
      )}
    >
      <Streamdown components={markdownComponents} plugins={markdownPlugins} urlTransform={safeMarkdownUrl} linkSafety={markdownLinkSafety}>
        {safeContent}
      </Streamdown>
    </div>
  );
});
