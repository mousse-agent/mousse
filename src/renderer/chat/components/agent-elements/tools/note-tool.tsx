import { memo } from "react";
import { ToolRowBase } from "./tool-row-base";
import { Markdown } from "../markdown";
import { MessageSquare } from "../../../../lib/icons";
import { thoughtHeading } from "../utils/format-tool";

/**
 * A note the agent wrote while it worked, folded into a finished turn's
 * activity: its first line, and the whole note when opened.
 */
export const NoteTool = memo(function NoteTool({ part }: { part: any }) {
  const text: string = typeof part?.input?.text === "string" ? part.input.text : "";
  const heading = thoughtHeading(text);
  return (
    <ToolRowBase
      icon={<MessageSquare size={18} />}
      completeLabel={heading || "Note"}
      isAnimating={false}
      expandable={text.trim() !== heading}
    >
      <Markdown
        content={text}
        className="text-base text-muted-foreground leading-relaxed [&_p]:leading-relaxed"
      />
    </ToolRowBase>
  );
});
