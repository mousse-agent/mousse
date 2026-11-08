/** Asks the shown composer to send what it holds (the Changes tab's "Send N comments"). */
export const COMPOSER_SEND_EVENT = 'mousse:composer-send'

export function requestComposerSend(): void {
  window.dispatchEvent(new Event(COMPOSER_SEND_EVENT))
}
