import { useEffect, useRef } from "react";
import type { CommandId } from "../../../../../shared/commands";
import { registerCommand } from "../../../../commands/commandRegistry";

/** Registered in the command table; the key binding and the palette row both come from there. */
export const FIND_IN_THREAD_COMMAND_ID: CommandId = "chat.findInThread";

/** Editors and embedded pages that keep Ctrl/Cmd+F for their own find widget. */
const OWN_FIND_SELECTOR = ".monaco-editor, webview, [data-find-own]";

/** One mounted transcript that can show a find bar. */
export type FindController = {
  container: () => HTMLElement | null;
  open: () => void;
};

const controllers = new Set<FindController>();

/**
 * The transcript Ctrl/Cmd+F belongs to: the one holding focus, else the last
 * one that was mounted and is showing. With one transcript this is that one;
 * with two (a remote thread beside a local one) the focused one wins.
 */
export function pickFindController(
  candidates: Iterable<FindController>,
  active: Element | null,
): FindController | null {
  let visible: FindController | null = null;
  for (const controller of candidates) {
    const container = controller.container();
    if (!container) continue;
    if (active && container.contains(active)) return controller;
    // `checkVisibility` is missing in older engines and in jsdom: then assume it shows.
    const shows = typeof container.checkVisibility === "function" ? container.checkVisibility() : true;
    if (shows) visible = controller;
  }
  return visible;
}

/** Whether the focused element is one that owns Ctrl/Cmd+F itself. */
export function focusOwnsFind(active: Element | null): boolean {
  return Boolean(active?.closest(OWN_FIND_SELECTOR));
}

function activeElement(): Element | null {
  return typeof document === "undefined" ? null : document.activeElement;
}

function enabled(): boolean {
  return !focusOwnsFind(activeElement()) && pickFindController(controllers, activeElement()) !== null;
}

function run(): void {
  pickFindController(controllers, activeElement())?.open();
}

let unregister: (() => void) | null = null;

/** Adds a transcript to the set Ctrl/Cmd+F can open; the command is registered while the set is not empty. */
export function addFindController(controller: FindController): () => void {
  controllers.add(controller);
  if (controllers.size === 1) unregister = registerCommand(FIND_IN_THREAD_COMMAND_ID, { run, enabled });
  return () => {
    controllers.delete(controller);
    if (controllers.size === 0) {
      unregister?.();
      unregister = null;
    }
  };
}

/**
 * Makes Ctrl/Cmd+F open this transcript's find bar. The key goes through the
 * command registry like every other shortcut: the registry's dispatcher refuses
 * it in a terminal, in the browser surface, and while the command palette or
 * another dialog owns the keyboard; the handler also leaves Monaco its own
 * find widget. Text fields (the composer) may have focus.
 */
export function useFindShortcut(controller: FindController, active: boolean): void {
  const latest = useRef(controller);
  latest.current = controller;
  useEffect(() => {
    if (!active) return;
    return addFindController({
      container: () => latest.current.container(),
      open: () => latest.current.open(),
    });
  }, [active]);
}
