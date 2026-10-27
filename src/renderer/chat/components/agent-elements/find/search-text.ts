import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkMousseMath } from "../../../../markdown/math/remark-mousse-math";
import { hideUnclosedMathFence, mayContainMath } from "../../../../markdown/math/math-detect";
import { normalizeCodeFenceLanguages, normalizeMarkdown } from "../markdown";

/**
 * The text of a Markdown reply as the reader sees it, in the blocks the page
 * draws it in. Find counts occurrences in these blocks, so they follow the
 * rendered text and not the source: `**bold**` is `bold`, a link is its label,
 * an image contributes nothing, a table cell is a block of its own.
 *
 * The parse is the one Streamdown renders (`remark-parse` + `remark-gfm`, plus
 * the math syntax while math is on), after the same two normalizers.
 */

type MarkdownNode = {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MarkdownNode[];
};

const plainParser = unified().use(remarkParse).use(remarkGfm);
const mathParser = unified().use(remarkParse).use(remarkGfm).use(remarkMousseMath);

/** Fences the page draws as something other than text. */
function isDrawnFence(node: MarkdownNode, math: boolean): boolean {
  const lang = (node.lang ?? "").toLowerCase();
  return lang === "mermaid" || (math && lang === "math");
}

class BlockWriter {
  readonly blocks: string[] = [];
  private current = "";

  text(value: string): void {
    // A soft line break reads as a space in prose, on the page and here. Each
    // character is replaced, so the text keeps its length.
    this.current += value.replace(/[\r\n]/g, " ");
  }

  verbatim(value: string): void {
    this.current += value;
  }

  flush(): void {
    if (this.current !== "") this.blocks.push(this.current);
    this.current = "";
  }
}

function writeInline(node: MarkdownNode, out: BlockWriter): void {
  switch (node.type) {
    case "text":
      out.text(node.value ?? "");
      return;
    case "inlineCode":
      out.verbatim(node.value ?? "");
      return;
    case "break":
      out.flush();
      return;
    case "image":
    case "imageReference":
    case "html":
    case "footnoteReference":
    case "math":
    case "inlineMath":
      return;
    default:
      for (const child of node.children ?? []) writeInline(child, out);
  }
}

function writeBlock(node: MarkdownNode, out: BlockWriter, math: boolean): void {
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "tableCell":
      out.flush();
      for (const child of node.children ?? []) writeInline(child, out);
      out.flush();
      return;
    case "code":
      out.flush();
      if (!isDrawnFence(node, math)) out.verbatim(node.value ?? "");
      out.flush();
      return;
    case "thematicBreak":
    case "html":
    case "definition":
    case "footnoteDefinition":
    case "math":
    case "inlineMath":
    case "yaml":
      out.flush();
      return;
    default:
      // root, list, listItem, blockquote, table, tableRow
      out.flush();
      for (const child of node.children ?? []) writeBlock(child, out, math);
      out.flush();
  }
}

/**
 * `math` says whether the page parses math (the Render math setting is not
 * off); a reply without math syntax is parsed the plain way either way.
 */
export function markdownToSearchBlocks(markdown: string, options: { math?: boolean } = {}): string[] {
  const math = Boolean(options.math) && mayContainMath(markdown);
  const prepared = normalizeCodeFenceLanguages(
    normalizeMarkdown(math ? hideUnclosedMathFence(markdown) : markdown),
    math,
  );
  const tree = (math ? mathParser : plainParser).parse(prepared) as Nodes;
  const out = new BlockWriter();
  writeBlock(tree as MarkdownNode, out, math);
  return out.blocks;
}

/** A prompt is plain text, not Markdown: one block, with line breaks read as spaces. */
export function plainTextToSearchBlocks(text: string): string[] {
  const value = text.replace(/[\r\n]/g, " ");
  return value === "" ? [] : [value];
}
