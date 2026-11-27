import { memo } from "react";
import { CircleX } from "../../../lib/icons";
import { cn } from "./utils/cn";
import { ReportButton } from "../../../components/bugReports/ReportButton";
import { splitErrorReference } from "../../../lib/errorText";
import { openExternalUrl } from "../../../components/PullRequestMarkdown";
import type { ErrorAction } from "../../adapters/mousseToUI";

export type ErrorMessageProps = {
  title?: string;
  message: string;
  className?: string;
  /** Sends the turn's prompt again. No button when absent. */
  onRetry?: () => void;
  /** Tooltip and accessible name of the Retry button; it starts with "Retry", the button's text. */
  retryTitle?: string;
  /** A web page that fixes the failure (ChatGPT's app limits), offered before Retry. */
  action?: ErrorAction;
};

export { splitErrorReference };

/**
 * A failed request in the transcript: the title in the danger colour, then the message as the provider or Mousse gave
 * it. A reference the error was logged under goes on a quiet line under it, with Retry.
 */
export const ErrorMessage = memo(function ErrorMessage({
  title = "Something went wrong",
  message,
  className,
  onRetry,
  retryTitle = "Retry",
  action,
}: ErrorMessageProps) {
  const { text, reference } = splitErrorReference(message);
  // A text button, as "Run interrupted · Continue" offers Continue.
  const retry = onRetry ? (
    <button
      type="button"
      onClick={onRetry}
      aria-label={retryTitle}
      title={retryTitle}
      className="ml-1 -my-1 inline-flex h-6 items-center rounded-md px-2 align-middle text-an-foreground hover:bg-an-foreground/10 focus-visible:outline-none focus-visible:bg-an-foreground/10"
    >
      Retry
    </button>
  ) : null;
  const link = action ? (
    <button
      type="button"
      onClick={() => openExternalUrl(action.url)}
      aria-label={action.title}
      title={action.title}
      className="ml-1 -my-1 inline-flex h-6 items-center rounded-md px-2 align-middle text-an-foreground hover:bg-an-foreground/10 focus-visible:outline-none focus-visible:bg-an-foreground/10"
    >
      {action.label}
    </button>
  ) : null;
  // Report (Settings → General → Report button): the report dialog with this error's draft.
  const report = (
    <ReportButton className="ml-1 -my-1 align-middle" error={{ title, message, ...(reference ? { reference } : {}), surface: "transcript" }} />
  );
  return (
    <div className={cn("flex items-start gap-2 text-base", className)}>
      <CircleX size={16} className="mt-[3px] shrink-0 text-[var(--danger)]" />
      <div className="min-w-0">
        <div className="font-medium text-[var(--danger)]">{title}</div>
        <div className="an-error-text mt-0.5 text-an-foreground/80 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {text}
          {!reference && link}
          {!reference && retry}
          {!reference && report}
        </div>
        {reference && (
          <div className="an-error-meta mt-1 text-[12px] leading-5 text-an-foreground-muted">
            <span className="select-text">Reference {reference}</span>
            {link}
            {retry}
            {report}
          </div>
        )}
      </div>
    </div>
  );
});
