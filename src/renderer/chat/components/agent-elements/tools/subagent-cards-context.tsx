import { createContext, useContext } from "react";
import type { SubagentCardModel } from "../../../adapters/subagentCards";

const NO_CARDS: ReadonlyMap<string, SubagentCardModel> = new Map();

/**
 * The subagent cards of the open thread, by the tool call that started each task. The shell joins
 * the transcript with the daemon's subagent list; the list renderer reads which rows are cards, and
 * each row reads its own card.
 */
export const SubagentCardsContext = createContext<ReadonlyMap<string, SubagentCardModel>>(NO_CARDS);

/** The card for a tool call, or undefined when its raw row stays. */
export function useSubagentCard(toolCallId: string | undefined): SubagentCardModel | undefined {
  const cards = useContext(SubagentCardsContext);
  return toolCallId ? cards.get(toolCallId) : undefined;
}

export function useSubagentCards(): ReadonlyMap<string, SubagentCardModel> {
  return useContext(SubagentCardsContext);
}

/** The provider the open thread runs on, which a subagent that names none inherited. */
export const SubagentInheritedProviderContext = createContext<string | null>(null);

export function useInheritedProvider(): string | null {
  return useContext(SubagentInheritedProviderContext);
}
