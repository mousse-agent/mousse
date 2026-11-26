import { memo, type ComponentType, type ComponentProps, type ReactNode } from "react";
import type { UIMessage } from "ai";
import { ArrowTurnForward } from "../../../lib/icons";
import { UserMessage } from "./user-message";
import { heldInBlock, SteerHoldLine, useHeldSteer } from "./steer-hold";
import "../../../styles/steer-group.css";

interface SteerGroupProps {
  /** The messages steered into the reply one after another, in the order sent. */
  messages: UIMessage[];
  UserMessageComponent: ComponentType<ComponentProps<typeof UserMessage>>;
  className?: string;
  enableImagePreview?: boolean;
  /**
   * A steered message's actions (time, Read aloud, Copy, Repeat this), shown beside its bubble on hover or focus.
   * No Edit or Undo: a steer has no checkpoint of its own to rewind to.
   */
  renderActions?: (message: UIMessage) => ReactNode;
}

/**
 * Messages sent into a reply that was already running (Steer), where they entered it: one block under a
 * single "Steer" label, the bubbles stacked tight, so several steers read as one interruption.
 */
export const SteerGroup = memo(function SteerGroup({ messages, UserMessageComponent, className, enableImagePreview, renderActions }: SteerGroupProps) {
  // While the turn holds one of these steers for a running tool, the label row says what it waits for.
  const hold = useHeldSteer();
  const itemIds = messages.map((message) => (message.metadata as { steerItemId?: string } | undefined)?.steerItemId);
  const held = hold?.held && heldInBlock(hold.held, itemIds, { messageIds: messages.map((message) => message.id), newestSteerId: hold.newestSteerId }) ? hold.held : undefined;
  return (
    <div className="steer-group" role="group" aria-label="Steered messages" data-steer-group={messages[0]?.id}>
      <div className="steer-group-label">
        <span className="steer-group-title" title="Sent into the reply while it ran">
          <ArrowTurnForward size={12} strokeWidth={1.8} aria-hidden="true" />
          Steer
        </span>
        {held ? <SteerHoldLine held={held} threadId={hold?.threadId} /> : null}
      </div>
      <div className="steer-group-messages">
        {messages.map((message) => (
          // `data-prompt-id`: each steered message has its own tick on the prompt rail, which finds it by that id.
          <div key={message.id} data-steered-id={message.id} data-prompt-id={message.id} className="steer-group-item group/user-message">
            <UserMessageComponent message={message} className={className} enableImagePreview={enableImagePreview} />
            {renderActions?.(message)}
          </div>
        ))}
      </div>
    </div>
  );
});
