import type { Root } from "mdast";
import type {} from "remark-parse";
import { mathFromMarkdown } from "mdast-util-math";
import type { Processor } from "unified";
import {
  MATH_CLASS,
  MATH_DISPLAY_CLASS,
  delimiterClass,
  type MathDelimiter,
} from "./math-markup";
import { mathTables } from "./math-table";
import { mousseMath } from "./syntax";

type MathTreeNode = {
  type: string;
  value?: string;
  children?: MathTreeNode[];
  position?: { start: { offset?: number } };
  data?: {
    hProperties?: { className?: string[] };
    hChildren?: Array<{
      properties?: { className?: string[]; metastring?: string };
      children?: Array<{ value?: string }>;
    }>;
  };
};

function delimiterAt(source: string, offset: number): MathDelimiter {
  if (source.startsWith("$$", offset)) return "dollars";
  if (source.startsWith("$", offset)) return "dollar";
  return source.startsWith("\\[", offset) ? "bracket" : "paren";
}

function tagMath(node: MathTreeNode, source: string): void {
  const offset = node.position?.start.offset;
  if (offset === undefined || !node.data) return;
  const delimiter = delimiterAt(source, offset);
  const display = delimiter === "dollars" || delimiter === "bracket";
  if (node.type === "inlineMath") {
    node.data.hProperties = {
      className: [
        MATH_CLASS,
        display ? "math-display" : "math-inline",
        ...(display ? [MATH_DISPLAY_CLASS] : []),
        delimiterClass(delimiter),
      ],
    };
    return;
  }
  // A block: `$$ 1+1 $$` keeps its padding in the node value; trim it so the
  // tex is exactly the formula.
  const code = node.data.hChildren?.[0];
  const text = code?.children?.[0];
  if (!code || !text) return;
  node.value = node.value?.trim();
  text.value = text.value?.trim();
  code.properties = { ...code.properties, metastring: delimiter };
}

function visit(node: MathTreeNode, source: string): void {
  if (node.type === "inlineMath" || node.type === "math") tagMath(node, source);
  if (node.children) for (const child of node.children) visit(child, source);
}

/**
 * Math for chat Markdown: `$x$` (only when it does not look like money),
 * `$$x$$`, `\(x\)`, `\[x\]`, and `$$` / `\[` blocks. Nodes are the ones
 * `mdast-util-math` defines. Run it after remark-gfm.
 */
export function remarkMousseMath(this: Processor): (tree: Root, file: { value: unknown }) => void {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(mousseMath(), mathTables());
  (data.fromMarkdownExtensions ??= []).push(mathFromMarkdown());
  return (tree, file) => visit(tree as unknown as MathTreeNode, String(file.value));
}
