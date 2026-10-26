import { Component, Suspense, lazy, type ReactNode } from "react";
import type { CustomRendererProps } from "streamdown";
import { MathSource } from "./MathSource";
import { blockSource, inlineSource, type MathDelimiter } from "./math-markup";
import { useTypesetMath } from "./renderMathSetting";

const MathTypeset = lazy(() => import("./math-typeset"));

/** A chunk that fails to load leaves the source on screen instead of an error. */
class MathBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function Typeset(props: { tex: string; display: boolean; block: boolean; source: string }) {
  const typeset = useTypesetMath();
  const fallback = <MathSource source={props.source} block={props.block} />;
  if (!typeset) return fallback;
  return (
    <MathBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <MathTypeset {...props} />
      </Suspense>
    </MathBoundary>
  );
}

/** A formula inside a line of text (`$x$`, `\(x\)`, or display style such as `$$x$$`). */
export function MathInline({
  tex,
  display,
  delimiter,
}: {
  tex: string;
  display: boolean;
  delimiter: MathDelimiter;
}) {
  return <Typeset tex={tex} display={display} block={false} source={inlineSource(tex, delimiter)} />;
}

/** A `$$` / `\[` block or ```math fence, as a Streamdown code renderer. */
export function MathBlock({ code, isIncomplete, meta }: CustomRendererProps) {
  const tex = code.trim();
  const source = blockSource(tex, meta);
  if (isIncomplete) return <MathSource source={source} block />;
  return <Typeset tex={tex} display block source={source} />;
}
