"use client";

import { memo } from "react";
import { useLiveText } from "../../../stores/liveTextStore";
import { type MarkdownProps } from "./markdown";
import { PacedText } from "./paced-markdown";
import { countRender } from "./render-counts";

/**
 * A reply's text: its live text while it streams in (see liveTextStore), else the transcript's,
 * paced a finished block at a time while `paced` (reply-pacing.ts). A streamed update renders this,
 * its pacing and its Markdown only, never the turn or the transcript around it; while paced, the
 * Markdown renders again only when a block is revealed.
 */
export const LiveMarkdown = memo(function LiveMarkdown({
  messageId,
  content,
  paced,
  ...props
}: MarkdownProps & { messageId: string; paced: boolean }) {
  countRender("LiveMarkdown");
  const text = useLiveText(messageId, content);
  return <PacedText {...props} text={text} paced={paced} />;
});
