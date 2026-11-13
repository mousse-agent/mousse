import { createContext, useContext } from "react";

/** What is drawn after the turns (the queued messages) tells the transcript's end follower about its size. */
export interface AfterTurnsLayout {
  /**
   * It changed its own size outside a render, in a resize observer's callback. The end follower may
   * already have run for that frame, and the browser does not report the change to it again until the
   * next one: this lands on the new end in the same frame, before paint.
   */
  resized: () => void;
  /**
   * The person is folding part of it away (Show less). Call before the change is committed: the space
   * is not held for the reply as it is for something replaced near the end.
   */
  closing: () => void;
}

const NONE: AfterTurnsLayout = { resized: () => {}, closing: () => {} };

const AfterTurnsLayoutContext = createContext<AfterTurnsLayout>(NONE);

export const AfterTurnsLayoutProvider = AfterTurnsLayoutContext.Provider;

export function useAfterTurnsLayout(): AfterTurnsLayout {
  return useContext(AfterTurnsLayoutContext);
}
