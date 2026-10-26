import type { DiagramPlugin, MathPlugin } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import "katex/dist/katex.min.css";
import { resolveThemeIsDark } from "./utils/theme-is-dark";

// Dollar handling is done by normalizeMathDelimiters, which keeps prices
// like "$5 and $10" as text; remark-math only ever sees `$$`.
export const mathPlugin: MathPlugin = createMathPlugin({ singleDollarTextMath: false });

type MermaidModule = typeof import("mermaid").default;
let mermaidModule: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
  mermaidModule ??= import("mermaid").then((mod) => mod.default);
  return mermaidModule;
}

/**
 * Mermaid is several hundred KB, so it is loaded on the first diagram
 * instead of with the chat bundle. The theme is re-read per render so
 * diagrams drawn after a theme switch match it.
 */
export const mermaidPlugin: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid: (config) => ({
    initialize: () => {},
    render: async (id, source) => {
      const mermaid = await loadMermaid();
      mermaid.initialize({
        fontFamily: "inherit",
        ...config,
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: resolveThemeIsDark() ? "dark" : "default",
      });
      return mermaid.render(id, source);
    },
  }),
};
