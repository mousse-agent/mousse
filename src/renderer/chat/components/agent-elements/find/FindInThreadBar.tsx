import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ChevronDown, ChevronUp, X } from "../../../../lib/icons";

/** Typing waits this long for a pause before it searches. */
export const FIND_TYPING_DEBOUNCE_MS = 100;

export type FindInThreadBarProps = {
  inputRef: RefObject<HTMLInputElement | null>;
  /** The query searched for; the field shows what is typed, and sends it after a pause. */
  query: string;
  onQueryChange: (query: string) => void;
  /** "3 of 12", "No matches", or empty. */
  countLabel: string;
  hasMatches: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
};

/**
 * The find field over the transcript. Enter moves to the next match (or
 * searches at once what is still being typed), Shift+Enter to the previous
 * one, Escape closes it. Clearing the field clears the search at once.
 */
export function FindInThreadBar({
  inputRef,
  query,
  onQueryChange,
  countLabel,
  hasMatches,
  onNext,
  onPrevious,
  onClose,
}: FindInThreadBarProps) {
  const [value, setValue] = useState(query);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  const change = (next: string) => {
    setValue(next);
    cancel();
    if (next === "") onQueryChange("");
    else timer.current = setTimeout(() => {
      timer.current = null;
      onQueryChange(next);
    }, FIND_TYPING_DEBOUNCE_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (value !== query) {
        // The search for what was typed starts at the reader's place, like a pause would.
        cancel();
        onQueryChange(value);
      } else if (event.shiftKey) onPrevious();
      else onNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      onClose();
    }
  };
  return (
    <div role="search" data-find-ignore className="chat-find-bar">
      <input
        ref={inputRef}
        type="text"
        className="chat-find-input"
        aria-label="Find in thread"
        placeholder="Find in thread"
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="chat-find-count" aria-live="polite" data-empty={countLabel === "" || undefined}>
        {countLabel}
      </span>
      <button
        type="button"
        className="chat-find-button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!hasMatches}
        onClick={onPrevious}
      >
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="chat-find-button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!hasMatches}
        onClick={onNext}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button type="button" className="chat-find-button" aria-label="Close find" title="Close (Esc)" onClick={onClose}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
