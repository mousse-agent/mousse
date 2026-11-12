import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ImageLightbox, type LightboxImage } from "./image-lightbox";
import { indexInGallery } from "./image-sources";

type ImageGallery = {
  /** Opens the preview on this image, with the conversation's other images a step away. */
  open(image: LightboxImage): void;
};

const ImageGalleryContext = createContext<ImageGallery | null>(null);

/** The conversation's image preview, or null outside one (the image then opens alone). */
export function useImageGallery(): ImageGallery | null {
  return useContext(ImageGalleryContext);
}

/**
 * One image preview for a whole conversation: an image opened inside it steps through all of the
 * conversation's images. `images` is asked for only when an image opens (reading every message on
 * each streamed update would cost for nothing), and the set stays as it was until the preview closes.
 * An image not in the set opens alone.
 */
export function ImageGalleryProvider({ images, children }: { images: () => LightboxImage[]; children: ReactNode }) {
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const [shown, setShown] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  const open = useCallback((image: LightboxImage) => {
    const set = imagesRef.current();
    const index = indexInGallery(set, image);
    setShown(index < 0 ? { images: [image], index: 0 } : { images: set, index });
  }, []);
  const close = useCallback(() => setShown(null), []);
  // The value never changes, so opening an image renders no message again.
  const value = useMemo(() => ({ open }), [open]);
  return (
    <ImageGalleryContext.Provider value={value}>
      {children}
      {shown && <ImageLightbox open onClose={close} images={shown.images} initialIndex={shown.index} />}
    </ImageGalleryContext.Provider>
  );
}
