import type { CustomRenderer, MathPlugin } from "streamdown";
import { MathBlock } from "./MathView";
import { remarkMousseMath } from "./remark-mousse-math";

// Streamdown applies `plugins.math.remarkPlugin` after remark-gfm and keeps its
// own defaults. Typesetting happens in the components instead of a rehype
// plugin: sanitizing runs before that slot and would strip KaTeX's markup.
export const mousseMathPlugin: MathPlugin = {
  name: "katex",
  type: "math",
  remarkPlugin: remarkMousseMath,
  rehypePlugin: () => undefined,
};

/** `$$` and `\[` blocks and ```math fences all arrive as code in the language "math". */
export const mathRenderers: CustomRenderer[] = [{ language: ["math"], component: MathBlock }];
