/**
 * Publishes the composer stack's height to the chat shell as `--chat-composer-stack`.
 * The transcript's bottom padding and fade, the prompt rail and Go to latest all read it.
 *
 * Changing that property restyles the whole transcript, so it must not change on every
 * frame while the composer folds or unfolds (`data-composer-motion`). When a fold starts,
 * the stack's settled height is written once; size changes during the fold are ignored,
 * and Go to latest glides to its new place with a transform instead of jumping.
 */

export const COMPOSER_STACK_VAR = "--chat-composer-stack";
const MOTION_ATTR = "data-composer-motion";
const COMPACT_ATTR = "data-composer-compact";
const JUMP_SELECTOR = ".chat-jump";

/** Same timing as the composer's fold transition in compact-composer.css. */
const FOLD_TIMING: KeyframeAnimationOptions = {
  duration: 200,
  easing: "ease-out",
  composite: "add",
};

function isFoldTransition(animation: Animation): boolean {
  const property = (animation as Animation & { transitionProperty?: string })
    .transitionProperty;
  return typeof property === "string" && property.endsWith("height");
}

/**
 * The stack's height once its fold transitions end: seek them to their end, read the
 * height, then put them back where they were. Costs one extra layout, once per fold.
 */
export function settledStackHeight(stack: HTMLElement): number {
  const running =
    typeof stack.getAnimations === "function"
      ? stack.getAnimations({ subtree: true }).filter(isFoldTransition)
      : [];
  const resume: Array<() => void> = [];
  for (const animation of running) {
    const end = animation.effect?.getComputedTiming().endTime;
    if (typeof end !== "number" || !Number.isFinite(end)) continue;
    const time = animation.currentTime;
    animation.currentTime = end;
    resume.push(() => {
      animation.currentTime = time;
    });
  }
  const height = stack.offsetHeight;
  for (const restore of resume) restore();
  return height;
}

export function watchComposerStackHeight(
  stack: HTMLElement,
  shell: HTMLElement,
): () => void {
  let published: number | null = null;

  /** Writes the height; returns the one it replaced, or undefined when nothing changed. */
  const publish = (height: number): number | null | undefined => {
    const previous = published;
    if (previous === height) return undefined;
    published = height;
    shell.style.setProperty(COMPOSER_STACK_VAR, `${height}px`);
    return previous;
  };

  const folding = () => shell.hasAttribute(MOTION_ATTR);

  const follow = () => {
    if (!folding()) publish(stack.offsetHeight);
  };

  let glide: { animation: Animation; offset: number } | null = null;

  /** Go to latest sits a fixed gap above the stack: start it where it was and glide. */
  const glideJump = (offset: number) => {
    const jump = shell.querySelector<HTMLElement>(JUMP_SELECTOR);
    if (typeof jump?.animate !== "function") return;
    // A fold reversed mid-way continues from where the pill is now.
    if (glide) {
      const progress = glide.animation.effect?.getComputedTiming().progress;
      if (typeof progress === "number") offset += glide.offset * (1 - progress);
      glide.animation.cancel();
    }
    const animation = jump.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
      FOLD_TIMING,
    );
    glide = { animation, offset };
    animation.onfinish = () => {
      if (glide?.animation === animation) glide = null;
    };
  };

  const startFold = () => {
    const previous = publish(settledStackHeight(stack));
    if (previous == null || published == null) return;
    glideJump(published - previous);
  };

  follow();
  const resize = new ResizeObserver(follow);
  resize.observe(stack);
  // A fold, or a fold reversed before the last one finished (motion stays on).
  const fold = new MutationObserver(() => {
    if (folding()) startFold();
    else follow();
  });
  fold.observe(shell, { attributes: true, attributeFilter: [MOTION_ATTR, COMPACT_ATTR] });

  return () => {
    resize.disconnect();
    fold.disconnect();
    shell.style.removeProperty(COMPOSER_STACK_VAR);
  };
}
