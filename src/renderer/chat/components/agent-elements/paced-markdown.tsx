import { memo } from "react";
import { Markdown, type MarkdownProps } from "./markdown";
import { usePacedText } from "./reply-pacing";
import { useReplyPacing } from "../../../lib/replyPacingSetting";

type PacedProps = Omit<MarkdownProps, "content"> & {
  /** Show only finished blocks, paced (reply-pacing.ts). */
  paced: boolean;
};

/**
 * Pacing between a reply's text and its Markdown, for any source of the text: the text as it is
 * now goes in, the part to show goes to Markdown. A reveal re-renders this and its Markdown only.
 * A live-text source (one that renders on each streamed update) wraps it as
 * `<PacedText text={useLiveText(id, content)} paced={paced} … />`.
 */
export function PacedText({ text, paced, ...props }: PacedProps & { text: string }) {
  const enabled = useReplyPacing();
  const shown = usePacedText(text, paced && enabled);
  return <Markdown {...props} content={shown} />;
}

/** A reply's Markdown from the transcript's text, shown a finished block at a time while `paced`. */
export const PacedMarkdown = memo(function PacedMarkdown({ content, ...props }: PacedProps & { content: string }) {
  return <PacedText {...props} text={content} />;
});
