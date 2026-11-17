"use client";

import {
  cloneElement,
  isValidElement,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
  type UIEvent,
} from "react";
import { flushSync } from "react-dom";
import type { Element as HastElement, ElementContent } from "hast";
import {
  CodeBlockContainer,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  CodeBlockHeader,
  StreamdownContext,
  useIsCodeFenceIncomplete,
  type Components,
  type CustomRenderer,
  type ExtraProps,
} from "streamdown";
import { cn } from "./utils/cn";
import { codeHighlighter } from "./code-highlighter";
import { linePieces, nearViewportNow, watchNearViewport, type TokenLine } from "./code-colours";

/**
 * A fenced code block. It looks and behaves like Streamdown's (the same container, header, Copy and classes), with a
 * lighter body. Streamdown drew one element per line and one per token, each with an inline style, so long threads
 * with code created and dropped hundreds of thousands of nodes as they scrolled, and the window kept that memory.
 *
 * Here a line is one text node until its block first comes near the viewport. Then its tokens are drawn as runs of one
 * colour, each a span with a class shared by every run of those colours (code-colours.ts), and the plain text between
 * them as text. Rows mounted only for a moment (opening a long thread mounts dozens before trimming to what shows)
 * and blocks never scrolled to stay plain. A long block colours the lines its box can show, and more as it is
 * scrolled.
 */

/** Streamdown drops a block's trailing line breaks before drawing it. */
const withoutTrailingBreaks = (code: string) => code.replace(/\n+$/, "");

/** Lines a block colours before it is scrolled: more than its 640px box shows at the smallest code size. */
const FIRST_COLOURED_LINES = 60;
/** The shortest a line can be (12px code at line-height 1.375), so a scroll offset never skips a line. */
const MIN_LINE_PX = 16;
/** Lines coloured past the bottom of the box. */
const MORE_LINES = 20;

/** Streamdown's reading of `codeBlockMaxHeight`: a number of pixels or a CSS length; none for 0, "none" or Infinity. */
function maxHeightOf(value: number | string | undefined): string | undefined {
  if (value === undefined || value === 0 || value === Number.POSITIVE_INFINITY) return undefined;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? `${value}px` : undefined;
  return value === "0" || value === "none" || value === "Infinity" ? undefined : value;
}

/**
 * One line, ending with its line break (the last line has none): its text as one text node, or its pieces when it
 * has tokens that spell it. Tokens of another version of the line leave it plain.
 */
const CodeLine = memo(function CodeLine({ text, end, tokens }: { text: string; end: boolean; tokens?: TokenLine }) {
  const tail = end ? "" : "\n";
  const pieces = tokens ? linePieces(tokens, text) : null;
  if (!pieces || pieces.length === 0) return text + tail;
  const last = pieces.length - 1;
  return pieces.map((piece, index) => {
    const value = index === last ? piece.text + tail : piece.text;
    return piece.colour ? (
      <span key={index} className={piece.colour}>
        {value}
      </span>
    ) : (
      value
    );
  });
});

type HighlightResult = NonNullable<ReturnType<typeof codeHighlighter.highlight>>;

const CodeBody = memo(function CodeBody({ code, language, className }: { code: string; language: string; className?: string }) {
  const { codeBlockMaxHeight, shikiTheme } = useContext(StreamdownContext);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => code.split("\n"), [code]);
  const maxHeight = maxHeightOf(codeBlockMaxHeight);
  const [seen, setSeen] = useState(false);
  const [coloured, setColoured] = useState(FIRST_COLOURED_LINES);
  const [tokens, setTokens] = useState<HighlightResult | null>(null);

  // Coloured from the first time the block comes near the viewport until it unmounts: colouring and uncolouring a
  // block each time it crosses that edge would draw its lines again and again. The observer first reports after a
  // frame is drawn, so the block's place is also read once at the next frame, and a block that mounts in view is
  // coloured in its first frame. Never here: reading layout in the middle of a commit lays the transcript out before
  // its window has resized its spacers, and the scroll position is clamped to that shorter page.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let done = false;
    let stop = () => {};
    const colour = (now: boolean) => {
      if (done) return;
      done = true;
      stop();
      if (now) flushSync(() => setSeen(true));
      else setSeen(true);
    };
    const first = requestAnimationFrame(() => {
      if (nearViewportNow(body)) colour(true);
    });
    stop = watchNearViewport(body, (near) => {
      if (near) colour(false);
    });
    return () => {
      cancelAnimationFrame(first);
      stop();
    };
  }, []);

  // The tokens of this text: at once when known (a block drawn again, a block growing), else when tokenised.
  useLayoutEffect(() => {
    let current = true;
    const result = codeHighlighter.highlight({ code, language: language as never, themes: shikiTheme }, (later) => {
      if (current) setTokens(later);
    });
    if (result) setTokens(result);
    return () => {
      current = false;
    };
  }, [code, language, shikiTheme]);

  const reach = seen ? Math.min(lines.length, coloured) : 0;
  const last = lines.length - 1;
  // A long block colours more lines as it is scrolled; a scroll offset of N lines can show no line past N.
  const onScroll =
    lines.length > coloured
      ? (event: UIEvent<HTMLDivElement>) => {
          const box = event.currentTarget;
          const needed = Math.ceil((box.scrollTop + box.clientHeight) / MIN_LINE_PX) + MORE_LINES;
          if (needed > coloured) setColoured(needed);
        }
      : undefined;

  return (
    <div
      ref={bodyRef}
      className={cn(className, maxHeight ? "overflow-y-auto" : null, "overflow-x-auto rounded-md border border-border bg-background p-4 text-sm")}
      data-language={language}
      data-streamdown="code-block-body"
      style={maxHeight ? { maxHeight } : undefined}
      onScroll={onScroll}
    >
      <pre className={cn(className, "bg-[var(--sdm-bg,inherit)]", "dark:bg-[var(--shiki-dark-bg,var(--sdm-bg,inherit))]")}>
        <code>
          {lines.map((text, index) => (
            <CodeLine key={index} text={text} end={index === last} tokens={index < reach ? tokens?.tokens[index] : undefined} />
          ))}
        </code>
      </pre>
    </div>
  );
});

export type CodeBlockProps = {
  code: string;
  language: string;
  isIncomplete?: boolean;
  /** The language class of the fence (`language-ts`), on the body as Streamdown puts it. */
  className?: string;
  /** The actions at the top right (Copy, a diagram's toggles). */
  children?: ReactNode;
};

/** A code block with Streamdown's frame, header and actions row, and the light body above. */
export function CodeBlock({ code, language, isIncomplete = false, className, children }: CodeBlockProps) {
  return (
    <CodeBlockContainer dir="ltr" isIncomplete={isIncomplete} language={language}>
      <CodeBlockHeader language={language} />
      {children ? (
        <div className="pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end">
          <div
            className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur"
            data-streamdown="code-block-actions"
          >
            {children}
          </div>
        </div>
      ) : null}
      <CodeBody code={withoutTrailingBreaks(code)} language={language} className={className} />
    </CodeBlockContainer>
  );
}

type Controls = boolean | { code?: boolean | { copy?: boolean; download?: boolean } };

/** Streamdown's reading of `controls` for code: whether the actions row shows, and Copy and Download in it. */
function codeControls(controls: Controls | undefined): { row: boolean; copy: boolean; download: boolean } {
  if (controls === undefined || typeof controls === "boolean") {
    const on = controls ?? true;
    return { row: on, copy: on, download: on };
  }
  const code = controls.code;
  if (code === false) return { row: false, copy: false, download: false };
  if (code === true || code === undefined) return { row: true, copy: true, download: true };
  return { row: true, copy: code.copy !== false, download: code.download !== false };
}

/** A fence in Markdown, with the actions its Streamdown sets up. */
const MarkdownCodeBlock = memo(function MarkdownCodeBlock({ code, language, className }: { code: string; language: string; className?: string }) {
  const isIncomplete = useIsCodeFenceIncomplete();
  const { controls } = useContext(StreamdownContext);
  const show = codeControls(controls as Controls | undefined);
  return (
    <CodeBlock code={code} language={language} className={className} isIncomplete={isIncomplete}>
      {show.row ? (
        <>
          {show.download ? <CodeBlockDownloadButton code={code} language={language} /> : null}
          {show.copy ? <CodeBlockCopyButton code={code} /> : null}
        </>
      ) : null}
    </CodeBlock>
  );
});

const LANGUAGE_CLASS = /language-([^\s]+)/;

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

const classNameOf = (element: HastElement): string => {
  const value = element.properties?.className;
  return Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : "";
};

/**
 * Streamdown's `pre`, drawing fenced code with `CodeBlock`. A language with its own renderer (math, mermaid) and
 * anything that is not a plain fence go to Streamdown's `code` as before.
 */
export function codeBlockPre(renderers: readonly CustomRenderer[]): ComponentType<ComponentProps<"pre"> & ExtraProps> {
  const ownRenderer = new Set(renderers.flatMap((renderer) => (Array.isArray(renderer.language) ? renderer.language : [renderer.language])));
  return function Pre({ node, children }: ComponentProps<"pre"> & ExtraProps) {
    const element = node?.children.find((child): child is HastElement => child.type === "element" && child.tagName === "code");
    const className = element ? classNameOf(element) : "";
    const language = LANGUAGE_CLASS.exec(className)?.[1] ?? "";
    if (!element || ownRenderer.has(language)) {
      // Streamdown's own `pre`: its `code` then draws the block.
      return isValidElement(children) ? cloneElement(children, { "data-block": "true" } as never) : <>{children}</>;
    }
    return <MarkdownCodeBlock code={textOf(element)} language={language} className={className || undefined} />;
  };
}

/** For a Streamdown that shows only code (a command preview, a tool's output): fences drawn with `CodeBlock`. */
export const codeOnlyComponents: Components = { pre: codeBlockPre([]) };
