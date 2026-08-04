/**
 * Resolve @earendil-works/pi-tui (0.80.7) shipped under pi-coding-agent.
 * Direct dependency is not required; nested install path is feature-detected.
 */

export interface PiTuiModule {
  Editor: new (
    tui: PiTuiInstance,
    theme: {
      borderColor: (s: string) => string
      selectList: {
        selectedPrefix: (s: string) => string
        selectedText: (s: string) => string
        description: (s: string) => string
        scrollInfo: (s: string) => string
        noMatch: (s: string) => string
      }
    }
  ) => {
    onSubmit?: (text: string) => void
    focused: boolean
    setText: (text: string) => void
  }
  Text: new (text?: string, paddingX?: number, paddingY?: number) => unknown
  Spacer: new (height?: number) => unknown
  Container: new () => {
    addChild: (c: unknown) => void
  }
  TUI: new (terminal: unknown) => PiTuiInstance
  ProcessTerminal: new () => unknown
  matchesKey: (data: string, key: string) => boolean
}

export interface PiTuiInstance {
  addChild: (c: unknown) => void
  setFocus: (c: unknown) => void
  start: () => void
  stop: () => void
  requestRender: () => void
  addInputListener: (
    fn: (data: string) => { consume?: boolean } | undefined
  ) => void
}

export async function loadPiTui(): Promise<PiTuiModule | null> {
  const candidates = [
    '@earendil-works/pi-tui',
    '@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js'
  ]
  for (const spec of candidates) {
    try {
      const mod = (await import(spec)) as PiTuiModule
      if (mod?.TUI && mod?.Editor && mod?.ProcessTerminal && mod?.Container) return mod
    } catch {
      // try next
    }
  }
  return null
}
