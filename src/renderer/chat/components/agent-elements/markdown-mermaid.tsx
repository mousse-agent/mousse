"use client";

import { memo, useEffect, useState, type ReactNode } from "react";
import {
  CodeBlock,
  CodeBlockContainer,
  CodeBlockCopyButton,
  CodeBlockHeader,
  type CustomRenderer,
  type CustomRendererProps,
} from "streamdown";
import { peekDiagram, renderDiagram, type DiagramOutcome } from "./mermaid-diagram";

const ACTION_BUTTON =
  "cursor-pointer p-1 text-xs text-muted-foreground transition-all hover:text-foreground";

type Drawn = { source: string; outcome: DiagramOutcome };

/** Draws `source` once `enabled`; `retry` draws again after a failed load. */
function useDiagram(source: string, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [drawn, setDrawn] = useState<Drawn | undefined>(() => {
    const outcome = enabled ? peekDiagram(source) : undefined;
    return outcome && { source, outcome };
  });

  useEffect(() => {
    if (!enabled) return;
    const known = peekDiagram(source);
    if (known) {
      setDrawn({ source, outcome: known });
      return;
    }
    let live = true;
    setDrawn(undefined);
    void renderDiagram(source).then((outcome) => {
      if (live) setDrawn({ source, outcome });
    });
    return () => {
      live = false;
    };
  }, [source, enabled, attempt]);

  return {
    // A result for the previous source must not show against the new one.
    outcome: drawn?.source === source ? drawn.outcome : undefined,
    retry: () => setAttempt((n) => n + 1),
  };
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end">
      <div
        className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1"
        data-streamdown="code-block-actions"
      >
        {children}
      </div>
    </div>
  );
}

function ToggleButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button className={ACTION_BUTTON} onClick={onClick} type="button">
      {children}
    </button>
  );
}

/** The fence as an ordinary code block, with copy and any extra actions. */
function SourceBlock({
  source,
  isIncomplete = false,
  children,
}: {
  source: string;
  isIncomplete?: boolean;
  children?: ReactNode;
}) {
  return (
    <CodeBlock code={source} language="mermaid" isIncomplete={isIncomplete}>
      {isIncomplete ? null : (
        <>
          {children}
          <CodeBlockCopyButton code={source} />
        </>
      )}
    </CodeBlock>
  );
}

function DiagramFailure({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <div className="an-md-diagram-error" role="alert">
      <div className="an-md-diagram-error-title">{title}</div>
      <pre className="an-md-diagram-error-message">{message}</pre>
      {children}
    </div>
  );
}

// Streamdown's own Mermaid block redraws on every streamed delta. This renderer
// shows the fence as code until it closes, then draws it once per distinct source.
const MermaidBlock = memo(function MermaidBlock({ code, isIncomplete }: CustomRendererProps) {
  const [showCode, setShowCode] = useState(false);
  const { outcome, retry } = useDiagram(code, !isIncomplete);

  if (isIncomplete || !outcome) {
    return (
      <div className="an-md-diagram" data-find-ignore data-mermaid-state={isIncomplete ? "streaming" : "drawing"}>
        <SourceBlock source={code} isIncomplete={isIncomplete} />
      </div>
    );
  }

  if (outcome.status === "ready" && !showCode) {
    return (
      <div className="an-md-diagram" data-find-ignore data-mermaid-state="ready">
        <CodeBlockContainer language="mermaid">
          <CodeBlockHeader language="mermaid" />
          <Actions>
            <ToggleButton onClick={() => setShowCode(true)}>Show code</ToggleButton>
            <CodeBlockCopyButton code={code} />
          </Actions>
          <div
            className="an-md-diagram-body"
            dangerouslySetInnerHTML={{ __html: outcome.svg }}
          />
        </CodeBlockContainer>
      </div>
    );
  }

  if (outcome.status === "ready") {
    return (
      <div className="an-md-diagram" data-find-ignore data-mermaid-state="code">
        <SourceBlock source={code}>
          <ToggleButton onClick={() => setShowCode(false)}>Show diagram</ToggleButton>
        </SourceBlock>
      </div>
    );
  }

  return (
    <div className="an-md-diagram" data-find-ignore data-mermaid-state={outcome.status}>
      {outcome.status === "unavailable" ? (
        <DiagramFailure title="Unable to load the diagram renderer" message={outcome.message}>
          <button className="an-md-diagram-retry" onClick={retry} type="button">
            Retry
          </button>
        </DiagramFailure>
      ) : (
        <DiagramFailure title="Unable to render diagram" message={outcome.message} />
      )}
      <SourceBlock source={code} />
    </div>
  );
});

/** Registered through Streamdown's `renderers`, not its `mermaid` plugin. */
export const mermaidRenderer: CustomRenderer = {
  language: "mermaid",
  component: MermaidBlock,
};
