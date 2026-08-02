export function stickyUserMessagePreview(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? 'Message'
  return `${firstLine.replace(/\.{3}$/, '')}...`
}

/** Return the newest user prompt that has reached the scroll viewport's top edge. */
export function findStickyUserMessageId(container: HTMLElement): string | null {
  const stickyEdge = container.getBoundingClientRect().top + 1
  let stickyId: string | null = null

  for (const message of container.querySelectorAll<HTMLElement>('[data-message-role="user"]')) {
    // Bounding geometry remains correct when an older element is already position:sticky,
    // unlike offsetTop/offsetParent arithmetic whose coordinate root may be outside the
    // scrolling element. Continue through all prompts so the newest eligible one wins.
    if (message.getBoundingClientRect().top <= stickyEdge) {
      stickyId = message.dataset.messageId ?? stickyId
    }
  }

  return stickyId
}
