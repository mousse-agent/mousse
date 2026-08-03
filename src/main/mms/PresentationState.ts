/**
 * Client-side presentation state for the GUI.
 * Thread selection is local; daemon remains the authority for thread data.
 */

export class PresentationState {
  private activeThreadId: string | null = null

  getActiveThreadId(): string | null {
    return this.activeThreadId
  }

  setActiveThreadId(threadId: string | null): void {
    this.activeThreadId = threadId
  }
}
