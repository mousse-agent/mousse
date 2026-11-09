import { useShortcutTitle } from "../../../../commands/commandRegistry";
import { Search } from "../../../../lib/icons";
import { FIND_IN_THREAD_COMMAND_ID } from "./use-find-shortcut";

/**
 * The small search button above the prompt rail: opens find in thread, as
 * Ctrl/Cmd+F does. A press does not take focus, so Escape in the bar gives it
 * back to whatever had it (the composer).
 */
export function FindRailButton({ onOpen }: { onOpen: () => void }) {
  const title = useShortcutTitle("Find in thread", FIND_IN_THREAD_COMMAND_ID);
  return (
    <button
      type="button"
      className="chat-prompt-find"
      aria-label="Find in thread"
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
    >
      <Search size={13} aria-hidden="true" />
    </button>
  );
}
