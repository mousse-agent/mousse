import React from "react";
import { cn } from "./utils/cn";

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
    animationDuration: `${duration}s`,
    animationIterationCount: "infinite",
    // About 15 updates a second, not every frame: each update redraws the whole window (agent-ui.css).
    animationTimingFunction: `steps(${Math.max(1, Math.round(duration * 15))})`,
  } as React.CSSProperties;

  return (
    <Component
      className={cn("an-text-shimmer", "an-text-shimmer--active", className)}
      style={style}
    >
      {children}
    </Component>
  );
}

export const TextShimmer = React.memo(TextShimmerComponent);
