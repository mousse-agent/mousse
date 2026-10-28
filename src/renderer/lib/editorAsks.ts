import type { EditorAskAnswerResult, EditorAskView } from '../../shared/bridge/editorAsk'
import type { NodeId } from '../../shared/net/ids'

/** Asks from other computers for editor connections, waiting for a person on this computer. */
export const listEditorAsks = (): Promise<EditorAskView[]> =>
  window.mousse.platformRequest.request<{ asks: EditorAskView[] }>('bridge.editorAsks', {}).then((value) => value.asks)

/** Allow turns the device's "Editor connections from this device" on, here only; Not now records a refusal. */
export const answerEditorAsk = (node: NodeId, allow: boolean): Promise<EditorAskAnswerResult> =>
  window.mousse.platformRequest.request<EditorAskAnswerResult>('bridge.editorAsk.answer', { node, allow })

/**
 * The ask to show next: the oldest one still waiting that was not closed. A closed mark holds the time the
 * closed ask runs out, so a later ask from the same computer is shown again.
 */
export function nextEditorAsk(
  asks: readonly EditorAskView[],
  dismissed: ReadonlyMap<string, number>,
  now: number
): EditorAskView | undefined {
  return asks
    .filter((ask) => ask.expiresAt > now && !((dismissed.get(ask.node) ?? -Infinity) >= ask.expiresAt))
    .reduce<EditorAskView | undefined>((oldest, ask) => (!oldest || ask.at < oldest.at ? ask : oldest), undefined)
}
