import { createContext, useContext, useEffect, useState } from "react";
import type { HeldSteer } from "../../../../shared/types";

/**
 * What the Steer block reads about a held steer (docs/design/steer-and-interruptions.md §2.10): the thread, and its
 * turn's `heldSteer` while a person's steer waits for a running tool. Without it (a list shown on its own) the block
 * shows no wait line and no Send now.
 */
export type HeldSteerState = { threadId?: string | null; held?: HeldSteer };

export const HeldSteerContext = createContext<HeldSteerState | null>(null);

export function useHeldSteer(): HeldSteerState | null {
  return useContext(HeldSteerContext);
}

/** The wait line's words and tooltips: terse on the line, what it waits for in the tooltip. */
export function describeHeldSteer(held: HeldSteer): { label: string; title: string; action: string; actionLabel: string } {
  const many = held.tools > 1;
  const what = many ? `${held.tools} tools` : held.waitsFor;
  const list = held.toolList?.map((tool) => (tool.detail ? `${tool.name}: ${tool.detail}` : tool.name)).join("\n");
  const title = many
    ? `Goes in when ${what} finish${list ? `\n${list}` : ""}`
    : `Goes in when ${what} finishes${held.detail ? `\n${held.detail}` : ""}`;
  return {
    label: `Waits for ${what}`,
    title,
    action: `Stop ${what} and send now`,
    actionLabel: `Send steer now, stops ${what}`,
  };
}

/** Whether the hold names one of the messages a Steer block shows (by their queue items). */
export function heldInBlock(held: HeldSteer | undefined, steerItemIds: readonly (string | undefined)[]): boolean {
  if (!held) return false;
  return steerItemIds.some((id) => id !== undefined && held.itemIds.includes(id));
}

/**
 * "Waits for Bash · Send now" in the Steer block's label row. Send now stops the tool and sends the steer at once; it
 * reads "Sending…" until the steer goes in (the hold clears), the click turns out stale, or the hold changes.
 */
export function SteerHoldLine({ held, threadId }: { held: HeldSteer; threadId?: string | null }) {
  const [sending, setSending] = useState<{ requestId: string; generation: number } | null>(null);
  // A new hold (a steer joined, or the hold ended and another began) shows its own button.
  const live = sending && sending.generation === held.holdGeneration ? sending : null;
  useEffect(() => {
    if (!live) return;
    return window.mousse?.orchestrator?.onSteerNow?.((outcome) => {
      if (outcome.requestId === live.requestId && outcome.outcome === "stale") setSending(null);
    });
  }, [live]);
  const words = describeHeldSteer(held);
  const sendNow = async () => {
    if (live || !threadId || !held.runId) return;
    const requestId = crypto.randomUUID();
    setSending({ requestId, generation: held.holdGeneration });
    try {
      const result = await window.mousse.orchestrator.steerNow({
        threadId,
        runId: held.runId,
        holdGeneration: held.holdGeneration,
        itemIds: held.itemIds,
        clientRequestId: requestId,
      });
      if (!result.ok) setSending(null);
    } catch {
      setSending(null);
    }
  };
  return (
    <>
      <span className="steer-group-sep" aria-hidden="true">·</span>
      <span className="steer-hold-wait" title={words.title} data-steer-hold={held.holdGeneration}>
        {words.label}
      </span>
      {threadId && held.runId ? (
        <>
          <span className="steer-group-sep" aria-hidden="true">·</span>
          <button
            type="button"
            className="steer-hold-send"
            title={live ? undefined : words.action}
            aria-label={live ? "Sending steer now" : words.actionLabel}
            aria-busy={live ? true : undefined}
            disabled={Boolean(live)}
            onClick={() => void sendNow()}
          >
            {live ? "Sending…" : "Send now"}
          </button>
        </>
      ) : null}
    </>
  );
}
