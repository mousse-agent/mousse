import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { UIMessage } from "ai";
import { FIND_REVEAL_EVENT } from "./find/reveal";
import { cn } from "./utils/cn";
import { FileAttachment } from "./input/file-attachment";
import { ImageLightbox } from "./image-lightbox";
import { useImageGallery } from "./image-gallery";
import { userMessageImages, userMessageImageTiles } from "./image-sources";
import { ChatReferencePill } from "../../../components/ReferencePill";
import { parseChatReference, type ChatReference } from "../../../../shared/chatReferences";
import { routeLink } from "../../../utils/chatLinks";
import { IconGitHub } from "./icons";
import { promptSegments } from "./prompt-links";

export type UserMessageProps = {
  message: UIMessage;
  className?: string;
  /**
   * When true (default) clicking an attached image opens a fullscreen
   * lightbox preview. Set to false to render images as plain thumbnails.
   */
  enableImagePreview?: boolean;
};

type MessagePart = UIMessage["parts"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextPart(part: MessagePart): part is { type: "text"; text: string } {
  return (
    part.type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

type FilePart = {
  type: "file";
  filename?: string;
  name?: string;
  fileName?: string;
  size?: number;
  mimeType?: string;
  mediaType?: string;
  url?: string;
  data?: string;
};

function getFileFromPart(part: unknown) {
  if (!isRecord(part)) return null;
  if (part.type !== "file") return null;
  const filePart = part as FilePart;
  const filename =
    filePart.filename || filePart.name || filePart.fileName || "Attachment";
  const mimeType = filePart.mimeType ?? filePart.mediaType;
  const isImage = mimeType?.startsWith("image/") ?? false;
  // Image parts WITH renderable data/url are shown as thumbnails via
  // getImageUrlFromPart — skip them here to avoid double rendering.
  // Image-named parts WITHOUT data (e.g. legacy messages saved before
  // image payloads persisted) render as image-icon chips so the attachment
  // is visible instead of silently vanishing.
  if (isImage && (filePart.url || filePart.data)) return null;
  return {
    filename,
    size: filePart.size,
    isImage,
  };
}

/** A long prompt shows this much (px) until "Show full message" is pressed. */
export const PROMPT_FOLD_HEIGHT = 176;

/**
 * True when the element's text is at least twice the fold height, so folding it hides enough to matter.
 *
 * Measured in the resize observer's callback only, never while React commits: reading a size during a
 * commit lays out the transcript half-way through a move of the turn window (the previous window's
 * spacers still in place), and the browser clamps the scroll position to that layout, undoing a jump
 * such as Find's to the last turn. The observer reports every element once it is observed, before the
 * frame is painted, and the fold is applied in that same frame.
 */
function useTallEnoughToFold(ref: RefObject<HTMLElement | null>, text: string): boolean {
  const [tall, setTall] = useState(false);
  const tallRef = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = element.scrollHeight >= PROMPT_FOLD_HEIGHT * 2;
      if (next === tallRef.current) return;
      tallRef.current = next;
      flushSync(() => setTall(next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text]);
  return tall;
}

/** The prompt's text with its links drawn as links: a GitHub one with the GitHub mark (see prompt-links). */
function PromptText({ text }: { text: string }) {
  const segments = promptSegments(text);
  if (segments.length === 1 && segments[0]!.kind === "text") return <>{text}</>;
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === "text" ? (
          segment.text
        ) : (
          <a
            key={i}
            href={segment.href}
            title={segment.href}
            // A short GitHub label stays on one line with its mark, so the mark never ends a line alone.
            className={cn("chat-user-link", segment.github && segment.text.length <= 24 && "is-unbroken")}
            onClick={(event) => {
              event.preventDefault();
              routeLink(segment.href);
            }}
          >
            {segment.github && <IconGitHub className="chat-user-link-icon" />}
            {segment.text}
          </a>
        ),
      )}
    </>
  );
}

export const UserMessage = memo(function UserMessage({
  message,
  className,
  enableImagePreview = true,
}: UserMessageProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const gallery = useImageGallery();
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const textParts = message.parts?.filter(isTextPart) ?? [];
  const text = textParts.map((p) => p.text).join("");
  const foldable = useTallEnoughToFold(textRef, text);
  const folded = foldable && !expanded;
  // Find landing on a match in the folded part opens the prompt, so the match is not hidden under the fold.
  useEffect(() => {
    const element = textRef.current;
    if (!element || !folded) return;
    const open = () => setExpanded(true);
    element.addEventListener(FIND_REVEAL_EVENT, open);
    return () => element.removeEventListener(FIND_REVEAL_EVENT, open);
  }, [folded]);

  const images = userMessageImageTiles(message);
  const files: Array<{ filename: string; size?: number; isImage?: boolean }> = [];
  const references: ChatReference[] = [];
  for (const part of message.parts ?? []) {
    if (isRecord(part) && part.type === "data-mousse-reference") {
      const reference = parseChatReference(part.data);
      if (reference) references.push(reference);
    }
    const file = getFileFromPart(part);
    if (file) files.push(file);
  }

  if (!text && images.length === 0 && files.length === 0 && references.length === 0) return null;

  // A turn sent from another of the user's computers says which one.
  const sentFromName = (message.metadata as { sentFrom?: { name?: unknown } } | undefined)?.sentFrom?.name;
  const sentFrom = typeof sentFromName === "string" && sentFromName ? sentFromName : undefined;

  const lightboxImages = userMessageImages(message);
  // In a conversation its one preview steps through all of the conversation's images; alone, through this prompt's.
  const openImage = (i: number) => (gallery ? gallery.open(lightboxImages[i]!) : setLightboxIndex(i));

  return (
    <div className={cn("flex flex-col items-end gap-1", className)}>
      <div className="chat-user-bubble max-w-[80%] p-3 rounded-an-message bg-an-user-message-bg text-an-user-message-text">
      {images.length > 0 && <div className="chat-user-image-carousel" role="region" aria-label="Attached images" tabIndex={0}>
        {images.map(({ url, name }, i) => {
          const label = name ?? `Image ${i + 1}`;
          const image = (
            <img
              src={url}
              alt={label}
              loading="lazy"
              decoding="async"
              className="block h-[120px] w-[184px] object-cover rounded-an-message-inner"
            />
          );
          const tileClass = "chat-user-image h-[132px] w-[196px] shrink-0 p-1.5 bg-an-foreground/4 rounded-an-message";
          return enableImagePreview ? (
            <button
              key={i}
              type="button"
              className={cn(tileClass, "cursor-pointer")}
              aria-label={name ? `Open ${name}` : `Open image ${i + 1}`}
              title={name}
              onClick={() => openImage(i)}
            >
              {image}
            </button>
          ) : (
            <div key={i} className={tileClass}>
              {image}
            </div>
          );
        })}
      </div>}
      {enableImagePreview && !gallery && lightboxImages.length > 0 && (
        <ImageLightbox
          open={lightboxIndex !== null}
          onClose={() => setLightboxIndex(null)}
          images={lightboxImages}
          initialIndex={lightboxIndex ?? 0}
        />
      )}
      {references.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {references.map((reference) => <ChatReferencePill key={reference.id} reference={reference} />)}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col items-end gap-2">
          {files.map((file, i) => (
            <FileAttachment
              key={`${file.filename}-${i}`}
              id={`${file.filename}-${i}`}
              filename={file.filename}
              size={file.size}
              isImage={file.isImage}
            />
          ))}
        </div>
      )}
      {text && (
        <p
          ref={textRef}
          className={cn("chat-user-text whitespace-pre-wrap wrap-break-word", folded && "is-folded")}
          data-find-text
          data-message-id={message.id}
          data-part-index="0"
        >
          <PromptText text={text} />
        </p>
      )}
      {text && foldable && (
        <button
          type="button"
          className="chat-user-fold"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show full message"}
        </button>
      )}
      </div>
      {sentFrom && (
        <span className="chat-user-sent-from" title={`Sent from ${sentFrom}`}>
          from {sentFrom}
        </span>
      )}
    </div>
  );
});
