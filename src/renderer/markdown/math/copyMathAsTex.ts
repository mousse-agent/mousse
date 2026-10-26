import type { ClipboardEvent } from "react";

/**
 * Copying inside one typeset formula puts its TeX on the clipboard; the
 * rendered glyphs and hidden MathML would otherwise paste as garbage. A
 * selection that spans more than one formula copies as usual.
 */
export function copyMathAsTex(event: ClipboardEvent<HTMLElement>): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const container = selection.getRangeAt(0).commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  const formula = element?.closest<HTMLElement>("[data-math-tex]");
  const tex = formula?.dataset.mathTex;
  if (!tex || !event.currentTarget.contains(formula)) return;
  event.clipboardData.setData("text/plain", tex);
  event.preventDefault();
}
