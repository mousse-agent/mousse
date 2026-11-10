import { memo, type ComponentType, type ComponentProps } from "react";
import type { UIMessage } from "ai";
import { ArrowTurnForward } from "../../../lib/icons";
import { UserMessage } from "./user-message";
import "../../../styles/steer-group.css";

interface SteerGroupProps {
  /** The messages steered into the reply one after another, in the order sent. */
  messages: UIMessage[];
  UserMessageComponent: ComponentType<ComponentProps<typeof UserMessage>>;
  className?: string;
  enableImagePreview?: boolean;
}

/**
 * Messages sent into a reply that was already running (Steer), where they entered it: one block under a
 * single "Steer" label, the bubbles stacked tight, so several steers read as one interruption.
 */
export const SteerGroup = memo(function SteerGroup({ messages, UserMessageComponent, className, enableImagePreview }: SteerGroupProps) {
  return (
    <div className="steer-group" role="group" aria-label="Steered messages" data-steer-group={messages[0]?.id}>
      <div className="steer-group-label" title="Sent into the reply while it ran">
        <ArrowTurnForward size={12} strokeWidth={1.8} aria-hidden="true" />
        Steer
      </div>
      <div className="steer-group-messages">
        {messages.map((message) => (
          <div key={message.id} data-steered-id={message.id}>
            <UserMessageComponent message={message} className={className} enableImagePreview={enableImagePreview} />
          </div>
        ))}
      </div>
    </div>
  );
});
