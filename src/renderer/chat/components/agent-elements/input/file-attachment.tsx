import { useState } from "react";
import {
  IconX as X,
  IconFileText as FileText,
  IconFileCode as FileCode,
  IconFileTypeJs as FileJson,
  IconPhoto as ImageIcon,
} from "../../../../lib/icons";
import { cn } from "../utils/cn";
import { ImageLightbox } from "../image-lightbox";

export type FileAttachmentProps = {
  id: string;
  filename: string;
  size?: number;
  isImage?: boolean;
  url?: string;
  onRemove?: () => void;
  className?: string;
  display?: "chip" | "image-only";
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
  onRemove,
  className,
  display = "chip",
  enableImagePreview = true,
}: FileAttachmentProps) {
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const iconName = getFileIconName(filename, isImage);
  // Image attachments with a renderable preview (pasted screenshots, dragged
  // images) render as a bare thumbnail — the auto-generated filename
  // ("paste-*.png", "Screenshot …") is noise. The real filename stays
  // discoverable via the hover tooltip on the chip.
  const isImageOnly = isImage && !!url;
  const canPreview = Boolean(enableImagePreview && isImage && url);

  const openLightbox = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsLightboxOpen(true);
  };

  return (
    <div
      className={cn(
        "relative bg-an-background-secondary rounded-[calc(var(--an-input-border-radius)-var(--an-context-padding))]",
        isImageOnly
          ? "size-32 flex items-center justify-center"
          : "flex items-center gap-2 pl-1 pr-2 py-1 min-w-[120px] max-w-[200px]",
        className,
      )}
      title={isImageOnly ? filename : undefined}
    >
      {isImageOnly ? (
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

          <div className="flex flex-col min-w-0">
            <span
              className="text-sm font-medium text-an-foreground truncate"
              title={filename}
            >
              {filename}
            </span>
            {size !== undefined && (
              <span className="text-[10px] text-an-foreground-muted">
                {formatFileSize(size)}
              </span>
            )}
          </div>
        </>
      )}

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
          className={`absolute top-1 right-1 size-5 rounded-full bg-an-background border border-an-border-color
                     flex items-center justify-center transition-[opacity,transform] duration-150 ease-out active:scale-[0.97] z-10
                     text-an-foreground hover:bg-an-background-secondary opacity-100`}
          aria-label={`Remove ${filename}`}
          type="button"
        >
          <X className="size-3" />
        </button>
      )}

      {canPreview && url && (
        <ImageLightbox
          open={isLightboxOpen}
          onClose={() => setIsLightboxOpen(false)}
          images={[{ id, url, filename }]}
        />
      )}
    </div>
  );
}
