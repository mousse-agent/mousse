import { useCallback, useEffect, useRef, useState } from "react";

/** How long `motion` stays on after a fold change; the CSS transition takes 200ms. */
export const COMPOSER_FOLD_MOTION_MS = 260;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * The composer folds to one line while the reader browses earlier messages.
 * `motion` is on only just after a fold change, so the CSS animates that
 * change and nothing else: focusing or typing switches the composer at once.
 * With reduced motion the fold always switches at once.
 */
export function useComposerFold() {
  const [fold, setFold] = useState({ compact: false, motion: false });
  const compactRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const onCompactChange = useCallback((compact: boolean) => {
    if (compact === compactRef.current) return;
    compactRef.current = compact;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const motion = !prefersReducedMotion();
    setFold({ compact, motion });
    if (!motion) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setFold((current) =>
        current.motion ? { ...current, motion: false } : current,
      );
    }, COMPOSER_FOLD_MOTION_MS);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return { ...fold, onCompactChange };
}
