import { memo, useState } from "react";
import type { UIMessage } from "ai";
import { cn } from "./utils/cn";
import { FileAttachment } from "./input/file-attachment";
import { ImageLightbox } from "./image-lightbox";

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

function getImageUrlFromPart(part: unknown): string | null {
  if (!isRecord(part)) return null;
  const type = part.type;
  if (typeof type !== "string") return null;

  if (type === "image") {
    const imagePart = part as { url?: string; image?: string };
    return imagePart.url ?? imagePart.image ?? null;
  }

  if (type === "data-image") {
    const dataPart = part as { data?: { url?: string } };
    return dataPart.data?.url ?? null;
  }

  if (type === "file") {
    const filePart = part as {
      mimeType?: string;
      mediaType?: string;
      url?: string;
      data?: string;
    };
    // The adapter emits AI SDK standard `mediaType`; be lenient and accept
    // legacy `mimeType` too.
    const mimeType = filePart.mimeType ?? filePart.mediaType;
    if (mimeType?.startsWith("image/")) {
      if (filePart.url) return filePart.url;
      if (filePart.data) {
        return `data:${mimeType};base64,${filePart.data}`;
      }
    }
  }

  return null;
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

export const UserMessage = memo(function UserMessage({
  message,
  className,
  enableImagePreview = true,
}: UserMessageProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const textParts = message.parts?.filter(isTextPart) ?? [];
  const text = textParts.map((p) => p.text).join("");

  const images: string[] = [];
  const files: Array<{ filename: string; size?: number; isImage?: boolean }> = [];
  for (const part of message.parts ?? []) {
    const imageUrl = getImageUrlFromPart(part);
    if (imageUrl) images.push(imageUrl);
    const file = getFileFromPart(part);
    if (file) files.push(file);
  }
  if (isRecord(message) && Array.isArray(message.experimental_attachments)) {
    for (const att of message.experimental_attachments as Array<{
      contentType?: string;
      url?: string;
    }>) {
      if (att.contentType?.startsWith("image/") && att.url) {
        images.push(att.url);
      }
    }
  }

  if (!text && images.length === 0 && files.length === 0) return null;

  const lightboxImages = images.map((url, i) => ({
    id: `${message.id}-img-${i}`,
    url,
    filename: `image-${i + 1}`,
  }));

  return (
    <div className={cn("flex flex-col items-end gap-1", className)}>
      {images.length > 0 &&
        images.map((url, i) => (
          <div
            key={i}
            className={cn(
              "max-w-[200px] p-1.5 bg-an-foreground/4 rounded-an-message",
              enableImagePreview && "cursor-pointer",
            )}
            onClick={
              enableImagePreview ? () => setLightboxIndex(i) : undefined
            }
          >
            <img
              src={url}
              alt="attachment"
              className="block object-cover max-w-[184px] max-h-[120px] rounded-an-message-inner"
            />
          </div>
        ))}
      {enableImagePreview && lightboxImages.length > 0 && (
        <ImageLightbox
          open={lightboxIndex !== null}
          onClose={() => setLightboxIndex(null)}
          images={lightboxImages}
          initialIndex={lightboxIndex ?? 0}
        />
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
        <div className="max-w-[calc(95%-40px)] ms-[70px]">
          <div className="px-3.5 py-1.5 text-sm transition-colors rounded-an-message bg-an-user-message-bg text-an-user-message-text">
            <p className="leading-5 whitespace-pre-wrap wrap-break-word">
              {text}
            </p>
          </div>
        </div>
      )}
    </div>
  );
});
