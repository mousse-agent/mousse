import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "../../../../lib/icons";

export type CopyIconButtonProps = {
  text: string;
  /** Tooltip and accessible name, e.g. "Copy command". */
  label: string;
};

/** Icon-only copy for a tool card; a check confirms the copy for two seconds. */
export function CopyIconButton({ text, label }: CopyIconButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setCopied(false);
        timer.current = null;
      }, 2000);
    }, () => undefined);
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      title={label}
      className="size-6 shrink-0 inline-flex items-center justify-center rounded-md text-an-tool-color-muted hover:text-an-tool-color hover:bg-an-foreground/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-an-border-color"
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  );
}
