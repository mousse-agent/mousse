export function stickyUserMessagePreview(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? 'Message'
  return `${firstLine.replace(/\.{3}$/, '')}...`
}

/**
 * Ids of user prompts whose body is taller than the sticky cap, so only those get the
 * fade affordance. Prompts pin through CSS alone, so this never reads scroll geometry:
 * measuring layout that scrolling cannot change keeps the pin loop-free.
 */
export function findOverflowingUserMessageIds(container: HTMLElement): Set<string> {
  const overflowing = new Set<string>()

  for (const message of container.querySelectorAll<HTMLElement>('[data-message-role="user"]')) {
    const messageId = message.dataset.messageId
    const body = message.querySelector<HTMLElement>('.message-body')
    if (messageId && body && body.scrollHeight > body.clientHeight + 1) {
      overflowing.add(messageId)
    }
  }

  return overflowing
}

export function sameMessageIdSet(current: Set<string>, next: Set<string>): boolean {
  return current.size === next.size && [...next].every((id) => current.has(id))
}
