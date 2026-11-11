import { memo } from "react";
import { Markdown, type MarkdownProps } from "./markdown";
import { usePacedText } from "./reply-pacing";
import { useReplyPacing } from "../../../lib/replyPacingSetting";

/**
 * A reply's Markdown, shown a finished block at a time while `paced` and the setting is on
 * (reply-pacing.ts). A reveal re-renders this component and its Markdown only.
 */
export const PacedMarkdown = memo(function PacedMarkdown({
  content,
  paced,
  ...props
}: MarkdownProps & { paced: boolean }) {
  const enabled = useReplyPacing();
  const shown = usePacedText(content, paced && enabled);
  return <Markdown {...props} content={shown} />;
});
