import { useRef, useState } from "react";
import { IconCheck, IconCopy } from "../../../lib/icons";
import { cn } from "./utils/cn";

/** Copy on a message's toolbar: its text as written; a check confirms it for two seconds. A thread's and a bot's chat. */
export function CopyButton({
  text,
  onCopied,
}: {
  text: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 2000);
    onCopied?.();
  };
  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        title="Copy"
        aria-label="Copy"
        className={cn(
          "size-6 flex items-center justify-center rounded-md active:scale-[0.97] transition-[background-color,opacity,transform] duration-150 ease-out",
          "opacity-50 bg-transparent hover:opacity-100 hover:bg-an-foreground/10",
        )}
      >
        <div className="relative w-3.5 h-3.5">
          <IconCopy
            className={cn(
              "absolute inset-0 w-3.5 h-3.5 text-an-foreground-muted transition-[opacity,transform] duration-150 ease-out",
              copied ? "opacity-0 scale-50" : "opacity-100 scale-100",
            )}
          />
          <IconCheck
            className={cn(
              "absolute inset-0 w-3.5 h-3.5 text-an-foreground-muted transition-[opacity,transform] duration-150 ease-out",
              copied ? "opacity-100 scale-100" : "opacity-0 scale-50",
            )}
          />
        </div>
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}
