/** Reports only from focused, non-idle Mousse windows. One report per profile/service per minute. */
export function appPresence(input: {
  windows(): Array<{ isDestroyed(): boolean; isFocused(): boolean; webContents: { id: number } }>
  idleSeconds(): number
  audience(senderId: number): string | undefined
  send(senderId: number, presence: { activeAt: number; timeZone: string }): Promise<unknown>
  clock?: () => number
  zone?: () => string
}): () => void {
  const sent = new Map<string, number>()
  return () => {
    if (input.idleSeconds() >= 60) return
    const now = input.clock?.() ?? Date.now()
    for (const win of input.windows()) {
      if (win.isDestroyed() || !win.isFocused()) continue
      const key = input.audience(win.webContents.id)
      if (!key || now - (sent.get(key) ?? -Infinity) < 60_000) continue
      sent.set(key, now)
      void input.send(win.webContents.id, { activeAt: now, timeZone: input.zone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => {})
    }
  }
}
