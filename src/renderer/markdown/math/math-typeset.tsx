// Loaded lazily (see MathView): KaTeX and its stylesheet, fonts included, only
// reach the app once a message actually contains math.
import "katex/dist/katex.min.css";
import { MathSource } from "./MathSource";
import { renderMath } from "./math-katex";

export type MathTypesetProps = {
  tex: string;
  display: boolean;
  /** A block (own line) rather than a formula inside a line of text. */
  block: boolean;
  /** The text as authored, shown when the formula cannot be typeset. */
  source: string;
};

export default function MathTypeset({ tex, display, block, source }: MathTypesetProps) {
  const html = renderMath(tex, display);
  if (html === null) return <MathSource source={source} block={block} />;
  const Tag = block ? "div" : "span";
  // The copy handler puts the TeX, or the source when text is copied too, on the clipboard.
  return (
    <Tag
      className="an-math"
      data-math-tex={tex}
      data-math-source={source}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
