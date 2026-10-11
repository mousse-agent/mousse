import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Observe mounted prompts only; recycled nodes are reconciled without rendering history. */
export function useVisiblePromptIds(
  containerRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  onLayoutChange: () => void,
): ReadonlySet<string> {
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(new Set());
  const layoutChangeRef = useRef(onLayoutChange);
  layoutChangeRef.current = onLayoutChange;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const targets = new Set<Element>();
    const visible = new Map<Element, string>();
    let frame = 0;

    const publish = () => {
      const next = new Set(visible.values());
      setVisibleIds((previous) =>
        previous.size === next.size && [...next].every((id) => previous.has(id))
          ? previous
          : next,
      );
    };
    const measure = () => {
      const bounds = container.getBoundingClientRect();
      const top = bounds.top + container.clientTop;
      const left = bounds.left + container.clientLeft;
      visible.clear();
      for (const target of targets) {
        const id = target.getAttribute("data-prompt-id");
        const rect = target.getBoundingClientRect();
        if (id && container.clientHeight > 0 && container.clientWidth > 0 &&
          rect.bottom > top && rect.top < top + container.clientHeight &&
          rect.right > left && rect.left < left + container.clientWidth) {
          visible.set(target, id);
        }
      }
      publish();
    };
    const observer = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!targets.has(entry.target)) continue;
            const id = entry.target.getAttribute("data-prompt-id");
            if (id && entry.isIntersecting && entry.intersectionRatio > 0) {
              visible.set(entry.target, id);
            } else {
              visible.delete(entry.target);
            }
          }
          publish();
        }, { root: container, threshold: 0 })
      : undefined;

    const reconcile = () => {
      frame = 0;
      const mounted = new Set(content.querySelectorAll("[data-prompt-id]"));
      for (const target of targets) {
        if (!mounted.has(target)) {
          observer?.unobserve(target);
          targets.delete(target);
          visible.delete(target);
        }
      }
      for (const target of mounted) {
        if (!targets.has(target)) {
          targets.add(target);
          observer?.observe(target);
        }
      }
      // Attribute recycling need not cross an intersection threshold.
      measure();
      layoutChangeRef.current();
    };
    const scheduleReconcile = () => {
      if (!frame) frame = requestAnimationFrame(reconcile);
    };
    const mutations = new MutationObserver(scheduleReconcile);
    mutations.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-prompt-id"] });
    reconcile();
    if (!observer) container.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", scheduleReconcile);
    return () => {
      observer?.disconnect();
      mutations.disconnect();
      if (frame) cancelAnimationFrame(frame);
      container.removeEventListener("scroll", measure);
      window.removeEventListener("resize", scheduleReconcile);
    };
  }, [containerRef, contentRef]);

  return visibleIds;
}
