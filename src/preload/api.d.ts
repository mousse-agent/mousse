import type { MousseAPI } from '../preload/index'

declare global {
  interface Window {
    mousse: MousseAPI
  }
}

export {}
