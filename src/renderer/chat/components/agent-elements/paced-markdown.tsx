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
 * LiveMarkdown feeds it a reply's live streamed text.
 */
export function PacedText({ text, paced, ...props }: PacedProps & { text: string }) {
  const enabled = useReplyPacing();
  const shown = usePacedText(text, paced && enabled);
  // Nothing finished to show yet: no empty block that would take a gap in the reply.
  if (!shown) return null;
  return <Markdown {...props} content={shown} />;
}
