import { useState } from "react";
import {
  IconX as X,
  IconFileText as FileText,
  IconFileCode as FileCode,
  IconFileTypeJs as FileJson,
  IconPhoto as ImageIcon,
  TextFont,
} from "../../../../lib/icons";
import { cn } from "../utils/cn";
import { ImageLightbox } from "../image-lightbox";
import { useImageGallery } from "../image-gallery";

export type FileAttachmentProps = {
  id: string;
  filename: string;
  size?: number;
  isImage?: boolean;
  url?: string;
  /** The chip's tooltip; defaults to the file name. */
  title?: string;
  /** A file chip that opens the file: its name and icon become a button. */
  onOpen?: () => void;
  /** A pasted text kept as a file: a button puts it into the message box instead. */
  onInsertText?: () => void;
  onRemove?: () => void;
  /** Makes the chip draggable: dragged out of the window, it drops the file. */
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void;
  className?: string;
  /** What getting the file ready to send came to: one short line on the chip, the details in its tooltip. */
  status?: { tone: "pending" | "info" | "error"; label: string; title: string };
  /**
   * `tile`: a file as a square the size of an image thumbnail, its icon at the top, its name at the bottom left and its
   * size at the bottom right, for a row that also holds thumbnails.
   */
  display?: "chip" | "image-only" | "tile";
  /**
   * When true (default) clicking the image thumbnail opens a fullscreen
   * preview. Set to false to render a non-interactive thumbnail.
   */
  enableImagePreview?: boolean;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type FileIconName = "image" | "code" | "data" | "text";

function getFileIconName(filename: string, isImage?: boolean): FileIconName {
  if (isImage) return "image";

  const ext = filename.split(".").pop()?.toLowerCase();

  if (
    [
      "js",
      "ts",
      "jsx",
      "tsx",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "kt",
      "swift",
      "c",
      "cpp",
      "h",
      "hpp",
      "cs",
      "php",
    ].includes(ext || "")
  ) {
    return "code";
  }

  if (["json", "yaml", "yml", "xml"].includes(ext || "")) {
    return "data";
  }

  return "text";
}

function renderFileIcon(iconName: FileIconName) {
  switch (iconName) {
    case "image":
      return <ImageIcon className="size-4 text-an-foreground-muted" />;
    case "code":
      return <FileCode className="size-4 text-an-foreground-muted" />;
    case "data":
      return <FileJson className="size-4 text-an-foreground-muted" />;
    default:
      return <FileText className="size-4 text-an-foreground-muted" />;
  }
}

/** An image thumbnail: a button that opens it large when it can, a plain box otherwise. */
function PreviewTarget({
  canPreview,
  filename,
  onOpen,
  className,
  children,
}: {
  canPreview: boolean;
  filename: string;
  onOpen: (event: React.MouseEvent) => void;
  className: string;
  children: React.ReactNode;
}) {
  if (!canPreview) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      className={cn(className, "block p-0 cursor-zoom-in")}
      aria-label={`Open ${filename}`}
      onClick={onOpen}
    >
      {children}
    </button>
  );
}

export function FileAttachment({
  id,
  filename,
  size,
  isImage,
  url,
  title,
  onOpen,
  onInsertText,
  onRemove,
  onDragStart,
  className,
  status,
  display = "chip",
  enableImagePreview = true,
}: FileAttachmentProps) {
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  // Among other attachments (the composer's), the preview steps through all of them.
  const gallery = useImageGallery();
  const iconName = getFileIconName(filename, isImage);
  // Image attachments with a renderable preview (pasted screenshots, dragged
  // images) render as a bare thumbnail — the auto-generated filename
  // ("image-1.png", "Screenshot …") is noise. The real filename stays
  // discoverable via the hover tooltip on the chip.
  const isImageOnly = isImage && !!url;
  const canPreview = Boolean(enableImagePreview && isImage && url);
  const isTile = display === "tile" && !isImageOnly;

  const openLightbox = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (gallery && url) gallery.open({ id, url, filename });
    else setIsLightboxOpen(true);
  };

  return (
    <div
      className={cn(
        "relative bg-an-background-secondary rounded-[calc(var(--an-input-border-radius)-var(--an-context-padding))]",
        isImageOnly
          ? "size-32 flex items-center justify-center"
          : isTile
            ? "size-32 flex flex-col justify-between p-2"
            : "flex items-center gap-2 pl-1 pr-2 py-1 min-w-[120px] max-w-[200px]",
        className,
      )}
      data-attachment-id={id}
      title={isImageOnly ? (status ? `${filename}: ${status.title}` : filename) : undefined}
      data-status={status?.tone}
      draggable={onDragStart ? true : undefined}
      onDragStart={onDragStart}
    >
      {isImageOnly && status && (
        <div className="composer-attachment-status-overlay">
          <span className="composer-attachment-status" data-tone={status.tone}>{status.label}</span>
        </div>
      )}
      {isTile ? (
        <>
          <div className="flex items-center justify-center size-8 bg-an-background-tertiary rounded-[calc(var(--an-input-border-radius)-var(--an-context-padding)-2px)]">
            {renderFileIcon(iconName)}
          </div>
          <div className="flex items-end gap-1.5 min-w-0">
            <span
              className="flex-1 min-w-0 text-sm font-medium text-an-foreground line-clamp-2 [overflow-wrap:anywhere]"
              title={status ? `${filename}: ${status.title}` : (title ?? filename)}
            >
              {filename}
            </span>
            {status ? (
              <span className="composer-attachment-status shrink-0" data-tone={status.tone} title={status.title}>
                {status.label}
              </span>
            ) : size !== undefined && (
              <span className="shrink-0 text-[10px] leading-5 text-an-foreground-muted">{formatFileSize(size)}</span>
            )}
          </div>
          {onOpen && (
            <button
              type="button"
              className="absolute inset-0 rounded-[inherit] cursor-pointer hover:bg-an-foreground/5"
              aria-label={`Open ${filename}`}
              title={title ?? filename}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpen();
              }}
            />
          )}
        </>
      ) : isImageOnly ? (
        <PreviewTarget
          canPreview={canPreview}
          filename={filename}
          onOpen={openLightbox}
          className="size-28 overflow-hidden shrink-0 rounded-[calc(var(--an-input-border-radius)-var(--an-context-padding)-2px)]"
        >
          <img
            src={url}
            alt={filename}
            className="w-full h-full object-cover"
          />
        </PreviewTarget>
      ) : (
        <>
          {isImage && url ? (
            <PreviewTarget
              canPreview={canPreview}
              filename={filename}
              onOpen={openLightbox}
              className="w-8 self-stretch overflow-hidden shrink-0 rounded-[calc(var(--an-input-border-radius)-var(--an-context-padding)-2px)]"
            >
              <img
                src={url}
                alt={filename}
                className="w-full h-full object-cover aspect-square"
              />
            </PreviewTarget>
          ) : (
            <div className="flex items-center justify-center w-8 self-stretch bg-an-background-tertiary shrink-0 rounded-[calc(var(--an-input-border-radius)-var(--an-context-padding)-2px)]">
              {renderFileIcon(iconName)}
            </div>
          )}

          <div className="flex flex-col flex-1 min-w-0">
            <span
              className="text-sm font-medium text-an-foreground truncate"
              title={status ? `${filename}: ${status.title}` : (title ?? filename)}
            >
              {filename}
            </span>
            {status ? (
              <span className="composer-attachment-status self-start" data-tone={status.tone} title={status.title}>
                {status.label}
              </span>
            ) : size !== undefined && (
              <span className="text-[10px] text-an-foreground-muted">
                {formatFileSize(size)}
              </span>
            )}
          </div>
          {/* The whole chip opens the file; the button lies over it, below the remove button. */}
          {onOpen && (
            <button
              type="button"
              className="absolute inset-0 rounded-[inherit] cursor-pointer hover:bg-an-foreground/5"
              aria-label={`Open ${filename}`}
              title={title ?? filename}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpen();
              }}
            />
          )}
        </>
      )}

      {onInsertText && !isImageOnly && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onInsertText();
          }}
          className={`${isTile ? "absolute top-1 right-7" : "shrink-0"} size-5 rounded-full flex items-center justify-center z-10 text-an-foreground-muted hover:text-an-foreground hover:bg-an-background`}
          aria-label="Insert as text"
          title="Insert as text"
        >
          <TextFont className="size-3.5" />
        </button>
      )}

      {/* On a chip the × has its own slot after the name, so a long name ellipsizes before it;
          a bare image thumbnail keeps it in the corner. */}
      {onRemove && (
        <button
          onMouseDown={(e) => {
            // Keep input focus stable when this button disappears after removal.
            e.preventDefault();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className={`${isImageOnly || isTile ? "absolute top-1 right-1" : "shrink-0"} size-5 rounded-full bg-an-background border border-an-border-color
                     flex items-center justify-center transition-[opacity,transform] duration-150 ease-out active:scale-[0.97] z-10
                     text-an-foreground hover:bg-an-background-secondary opacity-100`}
          aria-label={`Remove ${filename}`}
          type="button"
        >
          <X className="size-3" />
        </button>
      )}

      {canPreview && url && !gallery && (
        <ImageLightbox
          open={isLightboxOpen}
          onClose={() => setIsLightboxOpen(false)}
          images={[{ id, url, filename }]}
        />
      )}
    </div>
  );
}
