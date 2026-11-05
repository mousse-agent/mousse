import { memo } from "react";
import { CircleAlert, RefreshCw } from "../../../lib/icons";
import { cn } from "./utils/cn";

export type ErrorMessageProps = {
  title?: string;
  message: string;
  className?: string;
  /** Sends the turn's prompt again. No button when absent. */
  onRetry?: () => void;
  /** Tooltip and accessible name of the Retry button. */
  retryTitle?: string;
};

export const ErrorMessage = memo(function ErrorMessage({
  title = "Something went wrong",
  message,
  className,
  onRetry,
  retryTitle = "Retry",
}: ErrorMessageProps) {
  return (
    <div className={cn("flex items-start gap-2 text-base", className)}>
      <CircleAlert size={16} className="mt-[3px] shrink-0 text-[var(--danger)]" />
      <div className="min-w-0">
        <div className="font-medium text-[var(--danger)]">{title}</div>
        <div className="mt-0.5 text-an-foreground-muted break-words">{message}</div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          aria-label={retryTitle}
          title={retryTitle}
          className="size-7 shrink-0 inline-flex items-center justify-center rounded-md text-an-foreground-muted hover:text-an-foreground hover:bg-an-foreground/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-an-border-color"
        >
          <RefreshCw size={14} />
        </button>
      )}
    </div>
  );
});
