import { memo } from "react";
import { CircleAlert } from "../../../lib/icons";
import { cn } from "./utils/cn";

export type ErrorMessageProps = {
  title?: string;
  message: string;
  className?: string;
  /** Sends the turn's prompt again. No button when absent. */
  onRetry?: () => void;
  /** Tooltip and accessible name of the Retry button; it starts with "Retry", the button's text. */
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
        <div className="mt-0.5 text-an-foreground-muted break-words">
          {message}
          {/* A text button right after the message, as "Run interrupted · Continue" offers Continue. */}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              aria-label={retryTitle}
              title={retryTitle}
              className="ml-1 -my-1 inline-flex h-6 items-center rounded-md px-2 align-middle text-an-foreground hover:bg-an-foreground/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-an-border-color"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
