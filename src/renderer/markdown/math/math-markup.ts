/**
 * How math nodes are tagged on their way to HTML. Sanitizing keeps only
 * `language-*` classes on `code`, so the style and the delimiters the author
 * used travel as extra `language-math-…` classes (inline) or as the code
 * meta string (blocks).
 */

/** The delimiter pair the author wrote: `$x$`, `$$x$$`, `\(x\)`, `\[x\]`. */
export type MathDelimiter = "dollar" | "dollars" | "paren" | "bracket";

export const MATH_CLASS = "language-math";
export const MATH_DISPLAY_CLASS = "language-math-display";
const DELIMITER_PREFIX = "language-math-delim-";

export function delimiterClass(delimiter: MathDelimiter): string {
  return DELIMITER_PREFIX + delimiter;
}

export type MathClassInfo = { display: boolean; delimiter: MathDelimiter };

/** Reads the classes written by `remarkMousseMath`; null when this is not math. */
export function readMathClass(className: string | undefined): MathClassInfo | null {
  if (!className) return null;
  const classes = className.split(/\s+/);
  if (!classes.includes(MATH_CLASS)) return null;
  const tagged = classes.find((name) => name.startsWith(DELIMITER_PREFIX));
  const delimiter = (tagged?.slice(DELIMITER_PREFIX.length) ?? "dollar") as MathDelimiter;
  return { display: classes.includes(MATH_DISPLAY_CLASS), delimiter };
}

/** Inline source as authored, for when the formula cannot be typeset. */
export function inlineSource(tex: string, delimiter: MathDelimiter): string {
  switch (delimiter) {
    case "paren":
      return `\\(${tex}\\)`;
    case "bracket":
      return `\\[${tex}\\]`;
    case "dollars":
      return `$$${tex}$$`;
    default:
      return `$${tex}$`;
  }
}

/** Block source as authored; `meta` is the delimiter kind, or absent for a ```math fence. */
export function blockSource(tex: string, meta: string | undefined): string {
  if (meta === "bracket") return `\\[\n${tex}\n\\]`;
  if (meta === "dollars") return `$$\n${tex}\n$$`;
  return `\`\`\`math\n${tex}\n\`\`\``;
}
