import type { KeyboardEvent, RefObject } from "react";
import { ChevronDown, ChevronUp, X } from "../../../../lib/icons";

export type FindInThreadBarProps = {
  inputRef: RefObject<HTMLInputElement | null>;
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
 * The find field over the transcript. Enter moves to the next match,
 * Shift+Enter to the previous one, Escape closes it.
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
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
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
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
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
