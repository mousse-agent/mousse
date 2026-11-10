import { useState, type ComponentProps } from "react";
import { ImageLightbox } from "./image-lightbox";
import { cn } from "./utils/cn";

type MessageImageProps = ComponentProps<"img"> & { node?: unknown };

/** An image in a reply. Clicking it, or Enter while focused, opens it large; Esc closes it. */
export function MessageImage({ src, alt, className, node: _node, ...props }: MessageImageProps) {
  const [open, setOpen] = useState(false);
  if (typeof src !== "string" || !src) return null;
  const label = alt?.trim() || undefined;
  return (
    <>
      <button
        type="button"
        className="an-md-image my-2 inline-block max-w-full cursor-zoom-in rounded-lg align-top"
        aria-label={label ? `Open image: ${label}` : "Open image"}
        title={label}
        onClick={() => setOpen(true)}
      >
        <img
          {...props}
          src={src}
          alt={alt ?? ""}
          loading="lazy"
          decoding="async"
          className={cn("block max-w-full rounded-lg", className)}
        />
      </button>
      <ImageLightbox
        open={open}
        onClose={() => setOpen(false)}
        images={[{ id: src, url: src, filename: label }]}
      />
    </>
  );
}
