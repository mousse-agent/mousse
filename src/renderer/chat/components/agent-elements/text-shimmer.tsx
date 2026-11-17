import React from "react";
import { cn } from "./utils/cn";
import { useOffscreenPause } from "../../../lib/offscreenMotion";

export type TextShimmerProps = {
  children: React.ReactNode;
  as?: React.ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  delay?: number;
};

function TextShimmerComponent({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 100,
  delay = 0,
}: TextShimmerProps) {
  const style = {
    "--an-shimmer-duration": `${duration}s`,
    "--an-shimmer-spread": `${spread}px`,
    animationDelay: delay > 0 ? `${delay}s` : undefined,
    // Scaled by Settings > Animation speed, as the pulses beside it are.
    animationDuration: `calc(${duration}s * var(--ui-motion-scale, 1))`,
    animationIterationCount: "infinite",
    // About 15 updates a second, not every frame: each update redraws the whole window (agent-ui.css).
    animationTimingFunction: `steps(${Math.max(1, Math.round(duration * 15))})`,
  } as React.CSSProperties;
  // The sweep holds still while no one can see it (lib/offscreenMotion.ts).
  const pause = useOffscreenPause<HTMLElement>(true);

  return (
    <Component
      ref={pause}
      className={cn("an-text-shimmer", "an-text-shimmer--active", className)}
      style={style}
    >
      {children}
    </Component>
  );
}

export const TextShimmer = React.memo(TextShimmerComponent);
