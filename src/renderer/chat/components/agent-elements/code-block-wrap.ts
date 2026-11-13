/**
 * A Wrap toggle beside Copy on each code block of a reply. Long lines wrap by default
 * (`data-wrap` unset, agent-ui.css); the toggle switches a block to one line per line with a
 * horizontal scroll and back. Streamdown draws the block and its Copy button and has no slot for
 * another control, so the button is added to its actions row after each render; React leaves a
 * node it did not create where it is.
 */

const WRAP_BUTTON = "an-code-wrap";

// lucide "wrap-text", 12px like Copy.
const WRAP_ICON =
  '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16-3 3 3 3"/><path d="M3 12h14.5a1 1 0 0 1 0 7H13"/><path d="M3 19h6"/><path d="M3 5h18"/></svg>';

function sync(button: HTMLButtonElement, block: HTMLElement): void {
  const wrapped = block.dataset.wrap !== "off";
  button.setAttribute("aria-pressed", String(wrapped));
  button.title = wrapped ? "Don't wrap lines" : "Wrap lines";
}

/** Adds the Wrap toggle to every code block under `root` that has an actions row and no toggle yet. */
export function addCodeWrapToggles(root: HTMLElement): void {
  // Command previews and tool output keep one line per line and have no toggle.
  if (root.matches(".an-code-no-header, .an-tool-quiet-output")) return;
  for (const actions of root.querySelectorAll<HTMLElement>('[data-streamdown="code-block-actions"]')) {
    if (actions.querySelector(`.${WRAP_BUTTON}`)) continue;
    const block = actions.closest<HTMLElement>('[data-streamdown="code-block"]');
    if (!block) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = WRAP_BUTTON;
    button.setAttribute("aria-label", "Wrap lines");
    button.innerHTML = WRAP_ICON;
    sync(button, block);
    button.addEventListener("click", () => {
      block.dataset.wrap = block.dataset.wrap === "off" ? "on" : "off";
      sync(button, block);
    });
    actions.prepend(button);
  }
}
