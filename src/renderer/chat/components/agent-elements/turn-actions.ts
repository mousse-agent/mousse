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
  /**
   * Sends an edited version of the prompt with this message id (turn `turnId`): the conversation continues from
   * before that turn on a new branch, and the original stays a version to switch back to.
   */
  editPrompt?: (promptId: string, turnId: string, text: string) => Promise<void>;
};

export const TurnActionsContext = createContext<TurnActions | null>(null);

export function useTurnActions(): TurnActions | null {
  return useContext(TurnActionsContext);
}

type RetryImage = { data?: string };

/**
 * Retry and Continue over a thread's prompts. `prompt` reads a user message by
 * id when asked (not ahead of time, so a streamed token rebuilds nothing);
 * `send` is the composer's send.
 */
export function createTurnActions<Image extends RetryImage>({
  prompt,
  send,
  editPrompt,
}: {
  prompt: (promptId: string) => { content: string; images?: Image[] } | undefined;
  send: (content: string, images?: Image[]) => void;
  editPrompt?: TurnActions["editPrompt"];
}): TurnActions {
  return {
    ...(editPrompt ? { editPrompt } : {}),
    retryTitle: (promptId) => {
      const message = prompt(promptId);
      if (!message || !(message.content || message.images?.length)) return null;
      // An image of another computer's thread may be known by name only; it cannot go out again.
      return message.images?.some((image) => !image.data)
        ? "Retry (images not resent)"
        : "Retry";
    },
    retry: (promptId) => {
      const message = prompt(promptId);
      if (!message) return;
      const images = message.images?.filter((image) => image.data);
      send(message.content, images?.length ? images : undefined);
    },
    continueRun: () => send("Continue"),
  };
}
