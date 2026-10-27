/** Math that is not (or not yet) typeset: the text exactly as the author wrote it. */
export function MathSource({ source, block }: { source: string; block: boolean }) {
  // Find skips math: the formula is not prose, and the search index leaves it out too.
  if (!block) return <span className="an-math-source" data-find-ignore>{source}</span>;
  return (
    <pre data-find-ignore className="an-math-source my-2 overflow-x-auto whitespace-pre-wrap rounded border border-an-border-color bg-an-tool-background p-2 font-mono text-[0.85em]">
      {source}
    </pre>
  );
}
