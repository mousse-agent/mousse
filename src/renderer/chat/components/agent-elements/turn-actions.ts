import { createContext, useContext } from "react";

/**
 * Next steps offered on the last turn: Retry after an error, Continue after a
 * stopped run. Both send through the composer's normal send path.
 */
export type TurnActions = {
  /** Tooltip for Retry of the prompt with this message id; null when it cannot be sent again. */
  retryTitle: (promptId: string) => string | null;
  /** Sends the prompt with this message id again. */
  retry: (promptId: string) => void;
  /** Sends "Continue" to the thread. */
  continueRun: () => void;
};

export const TurnActionsContext = createContext<TurnActions | null>(null);

export function useTurnActions(): TurnActions | null {
  return useContext(TurnActionsContext);
}
