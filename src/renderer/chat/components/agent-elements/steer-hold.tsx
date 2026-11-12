import { createContext, useContext, useEffect, useId, useState } from "react";
import type { UIMessage } from "ai";
import type { HeldSteer } from "../../../../shared/types";

/**
 * What the Steer block reads about a held steer (docs/design/steer-and-interruptions.md §2.10): the thread, and its
 * turn's `heldSteer` while a person's steer waits for a running tool. Without it (a list shown on its own) the block
 * shows no wait line and no Send now. `newestSteerId`: the newest steered message, which shows a hold that names no
 * queue item (a steer from a device with a permission limit, or a run-bound steer).
 */
export type HeldSteerState = { threadId?: string | null; held?: HeldSteer; newestSteerId?: string };

export const HeldSteerContext = createContext<HeldSteerState | null>(null);

export function useHeldSteer(): HeldSteerState | null {
  return useContext(HeldSteerContext);
}

/** The wait line's words and tooltips: terse on the line, what it waits for in the tooltip. */
export function describeHeldSteer(held: HeldSteer): { label: string; title: string; action: string; actionLabel: string } {
  // Strict release after the last tool finished: the steer waits for the agent's turn to end, not for a tool.
  if (held.untilTurnEnd) {
    return {
      label: "Waits for the turn to end",
      title: "Goes in when the turn ends",
      action: "Send now without waiting for the turn to end",
      actionLabel: "Send now: does not wait for the turn to end",
    };
  }
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
    // Starts with the visible words, so a voice command that says what it sees ("Send now") reaches it.
    actionLabel: `Send now: stops ${what}`,
  };
}

/** The newest steered user message of a transcript: where a hold with no queue item is shown. */
export function newestSteerMessageId(messages: readonly UIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user" && (message.metadata as { steered?: boolean } | undefined)?.steered) return message.id;
  }
  return undefined;
}

/**
 * Whether the hold names one of the messages a Steer block shows: by their queue items, or, for a hold that names no
 * item, the block that holds the newest steered message (§2.9: the owner's process can force such entries).
 */
export function heldInBlock(
  held: HeldSteer | undefined,
  steerItemIds: readonly (string | undefined)[],
  block?: { messageIds: readonly string[]; newestSteerId?: string },
): boolean {
  if (!held) return false;
  if (held.itemIds.length === 0) return Boolean(block?.newestSteerId && block.messageIds.includes(block.newestSteerId));
  return steerItemIds.some((id) => id !== undefined && held.itemIds.includes(id));
}

/**
 * "Waits for Bash · Send now" in the Steer block's label row. Send now stops the tool and sends the steer at once; it
 * reads "Sending…" until the steer goes in (the hold clears), the click turns out stale, or the hold changes.
 */
export function SteerHoldLine({ held, threadId }: { held: HeldSteer; threadId?: string | null }) {
  const [sending, setSending] = useState<{ requestId: string; generation: number } | null>(null);
  const detailId = useId();
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
      {/* What it waits for, in full: the button's description, so a screen reader reaches it (a tooltip on text cannot take focus). */}
      <span id={detailId} className="steer-hold-detail" hidden>
        {words.title}
      </span>
      {threadId && held.runId ? (
        <>
          <span className="steer-group-sep" aria-hidden="true">·</span>
          <button
            type="button"
            className="steer-hold-send"
            title={live ? undefined : words.action}
            aria-label={live ? "Sending…" : words.actionLabel}
            aria-describedby={detailId}
            aria-busy={live ? true : undefined}
            // Not `disabled`: the button keeps keyboard focus while it sends.
            aria-disabled={live ? true : undefined}
            onClick={() => void sendNow()}
          >
            {live ? "Sending…" : "Send now"}
          </button>
        </>
      ) : null}
    </>
  );
}
