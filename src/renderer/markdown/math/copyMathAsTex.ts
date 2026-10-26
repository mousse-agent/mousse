import type { ClipboardEvent } from "react";

/**
 * Typeset formulas would otherwise paste as their rendered glyphs plus the
 * hidden MathML. A selection inside one formula copies its TeX; a selection
 * that also covers text copies every formula it touches as written, with its
 * delimiters (`\(x\)`, `$$…$$`).
 */
export function copyMathAsTex(event: ClipboardEvent<HTMLElement>): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const root = event.currentTarget;
  const container = range.commonAncestorContainer;
  if (!root.contains(container)) return;

  const element = container instanceof Element ? container : container.parentElement;
  const formula = element?.closest<HTMLElement>("[data-math-tex]");
  if (formula && root.contains(formula)) {
    event.clipboardData.setData("text/plain", formula.dataset.mathTex ?? "");
    event.preventDefault();
    return;
  }

  // Partly selected formulas are cloned whole enough to keep their data attributes.
  const fragment = range.cloneContents();
  const formulas = fragment.querySelectorAll<HTMLElement>("[data-math-tex]");
  if (formulas.length === 0) return;
  for (const typeset of formulas) {
    const source = document.createElement(typeset.tagName === "DIV" ? "div" : "span");
    source.style.whiteSpace = "pre-wrap";
    source.textContent = typeset.dataset.mathSource ?? typeset.dataset.mathTex ?? "";
    typeset.replaceWith(source);
  }

  // `innerText` gives the line breaks a normal copy has, but only for laid-out
  // nodes, so measure the copy off screen inside the Markdown root's styles.
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;";
  holder.append(fragment);
  const html = holder.innerHTML;
  root.append(holder);
  let text: string;
  try {
    text = holder.innerText ?? holder.textContent ?? "";
  } finally {
    holder.remove();
  }
  event.clipboardData.setData("text/plain", text);
  event.clipboardData.setData("text/html", html);
  event.preventDefault();
}
