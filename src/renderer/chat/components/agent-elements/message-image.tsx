import { useState, type ComponentProps } from "react";
import { ImageLightbox } from "./image-lightbox";
import { useImageGallery } from "./image-gallery";
import { cn } from "./utils/cn";

type MessageImageProps = ComponentProps<"img"> & { node?: unknown };

/**
 * An image in a reply. Clicking it, or Enter while focused, opens it large; Esc closes it. Inside a
 * conversation the preview steps through the conversation's other images; elsewhere it shows this one.
 */
export function MessageImage({ src, alt, className, node: _node, ...props }: MessageImageProps) {
  const [open, setOpen] = useState(false);
  const gallery = useImageGallery();
  if (typeof src !== "string" || !src) return null;
  const label = alt?.trim() || undefined;
  const image = { id: src, url: src, filename: label };
  return (
    <>
      <button
        type="button"
        className="an-md-image my-2 inline-block max-w-full cursor-zoom-in rounded-lg align-top"
        aria-label={label ? `Open image: ${label}` : "Open image"}
        title={label}
        onClick={() => (gallery ? gallery.open(image) : setOpen(true))}
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
      {!gallery && <ImageLightbox open={open} onClose={() => setOpen(false)} images={[image]} />}
    </>
  );
}
